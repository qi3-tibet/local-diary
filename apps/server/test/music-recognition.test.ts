import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/app.js";
import { createDiaryDatabase, type DiaryDatabase } from "../src/db/client.js";
import { EntryRepository } from "../src/entries/repository.js";
import { MediaStore } from "../src/media/store.js";
import { MusicService } from "../src/music/service.js";
import { createAcoustIdFingerprintLookup, runFpcalc } from "../src/music/recognition/fingerprint.js";
import { applyOverrides, recognizeMusic } from "../src/music/recognition/pipeline.js";
import { createMusicBrainzTextLookup } from "../src/music/recognition/text-lookup.js";
import type {
  FingerprintLookup,
  RecognitionCandidate,
  TextLookup,
} from "../src/music/recognition/types.js";

describe("music recognition pipeline", () => {
  it("uses a confident text candidate before fingerprint and keeps overrides authoritative", async () => {
    const text = fakeTextLookup([
      candidate({ id: "mb-1", title: "Song", artist: "Artist", score: 0.96 }),
    ]);
    const fingerprint = fakeFingerprintLookup([
      candidate({ id: "fp-1", title: "Wrong", artist: "Other", score: 0.99, source: "fingerprint" }),
    ]);

    const result = await recognizeMusic(
      { title: "Song", artist: "Artist", album: null, year: null, coverMediaId: null },
      "song.mp3",
      text,
      fingerprint,
    );

    expect(result).toMatchObject({ source: "text", manualRequired: false });
    expect(result.candidates[0]?.id).toBe("mb-1");
    expect(fingerprint.calls).toBe(0);
    expect(applyOverrides(result.candidates[0]!, { artist: "Corrected" }).artist).toBe("Corrected");
  });

  it("uses fingerprint after ambiguous text results", async () => {
    const text = fakeTextLookup([
      candidate({ id: "a", score: 0.62 }),
      candidate({ id: "b", score: 0.61 }),
    ]);
    const fingerprint = fakeFingerprintLookup([
      candidate({ id: "fp", score: 0.98, source: "fingerprint" }),
    ]);

    const result = await recognizeMusic(
      { title: null, artist: null, album: null, year: null, coverMediaId: null },
      "track.mp3",
      text,
      fingerprint,
      "C:\\music\\track.mp3",
    );

    expect(result.source).toBe("fingerprint");
    expect(result.candidates[0]?.id).toBe("fp");
    expect(fingerprint.filePaths).toEqual(["C:\\music\\track.mp3"]);
  });

  it("returns deterministic manual fallback when adapters fail or return malformed data", async () => {
    const text: TextLookup = { search: async () => { throw new Error("offline"); } };
    const fingerprint: FingerprintLookup = { search: async () => { throw new Error("missing fpcalc"); } };

    await expect(recognizeMusic(
      { title: null, artist: null, album: null, year: null, coverMediaId: null },
      "unknown.mp3",
      text,
      fingerprint,
    )).resolves.toEqual({
      source: "manual",
      candidates: [],
      manualRequired: true,
    });
  });
});

describe("MusicBrainz text lookup adapter", () => {
  it("uses a fixed HTTPS endpoint, encoded bounded query, user agent, and normalized scores", async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      recordings: [
        {
          id: "9f9b6ca8-8f0d-4f8c-ad6a-6a4acee9cf23",
          score: "97",
          title: "雨",
          "artist-credit": [{ artist: { name: "某人" } }],
          "first-release-date": "2020-05-02",
          releases: [{ id: "fd92cfb0-a8d5-4bd7-bbaf-c781e978bf43", title: "夜" }],
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const lookup = createMusicBrainzTextLookup({ request, timeoutMs: 50 });

    const results = await lookup.search({
      embedded: { title: "雨 / ? #", artist: "某人", album: "夜", year: null, coverMediaId: null },
      filename: "..\\odd ?# [mix].mp3",
    });

    expect(results).toEqual([
      {
        id: "musicbrainz:9f9b6ca8-8f0d-4f8c-ad6a-6a4acee9cf23",
        title: "雨",
        artist: "某人",
        album: "夜",
        year: 2020,
        coverMediaId: null,
        score: 0.97,
        source: "text",
        coverReleaseId: "fd92cfb0-a8d5-4bd7-bbaf-c781e978bf43",
      },
    ]);
    const [url, init] = request.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe("https://musicbrainz.org");
    expect(parsed.pathname).toBe("/ws/2/recording");
    expect(parsed.searchParams.get("limit")).toBe("5");
    expect(parsed.searchParams.get("fmt")).toBe("json");
    expect(parsed.searchParams.get("query")).toContain("雨 / ? #");
    expect(parsed.searchParams.get("query")).not.toContain("..\\");
    expect(new Headers(init?.headers).get("user-agent")).toMatch(/^LocalDiary\/\d/);
    expect(init?.redirect).toBe("error");
  });

  it("returns no candidates for empty signals, non-success, timeout, or malformed payloads", async () => {
    const never = vi.fn(async () => new Response("{}"));
    expect(await createMusicBrainzTextLookup({ request: never }).search({
      embedded: { title: null, artist: null, album: null, year: null, coverMediaId: null },
      filename: " .mp3",
    })).toEqual([]);
    expect(never).not.toHaveBeenCalled();

    for (const response of [
      new Response("busy", { status: 503 }),
      new Response("{", { status: 200 }),
      new Response(JSON.stringify({ recordings: [{ id: "not-a-uuid", score: "NaN" }] }), { status: 200 }),
    ]) {
      const lookup = createMusicBrainzTextLookup({ request: async () => response, timeoutMs: 10 });
      await expect(lookup.search({
        embedded: { title: "Song", artist: null, album: null, year: null, coverMediaId: null },
        filename: "song.mp3",
      })).resolves.toEqual([]);
    }
  });
});

describe("fingerprint adapter", () => {
  it("invokes fpcalc without a shell and validates its JSON output", async () => {
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify({ duration: 182.4, fingerprint: "AbC_123-xYz" }),
      stderr: "",
    }));

    await expect(runFpcalc(
      "C:\\Music & notes\\$(not-a-command).mp3",
      "C:\\tools\\fpcalc.exe",
      execute,
    )).resolves.toEqual({ duration: 182.4, fingerprint: "AbC_123-xYz" });

    expect(execute).toHaveBeenCalledWith(
      "C:\\tools\\fpcalc.exe",
      ["-json", "--", "C:\\Music & notes\\$(not-a-command).mp3"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("does not run fpcalc without a key and safely absorbs missing tools, timeouts, and malformed replies", async () => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const request = vi.fn(async () => new Response("{}"));
    const noKey = createAcoustIdFingerprintLookup({ clientKey: "", execute, request });
    expect(await noKey.search("C:\\music\\song.mp3")).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    const missing = createAcoustIdFingerprintLookup({ clientKey: "key", execute, request });
    await expect(missing.search("C:\\music\\song.mp3")).resolves.toEqual([]);

    const malformedExec = vi.fn(async () => ({ stdout: "{\"duration\":0}", stderr: "" }));
    const malformed = createAcoustIdFingerprintLookup({
      clientKey: "key",
      execute: malformedExec,
      request,
    });
    await expect(malformed.search("C:\\music\\song.mp3")).resolves.toEqual([]);
  });

  it("posts an encoded fingerprint to the fixed endpoint and bounds candidates", async () => {
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify({ duration: 201.2, fingerprint: "A_B-C" }),
      stderr: "",
    }));
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      status: "ok",
      results: [{
        id: "acoustid-track",
        score: 0.981,
        recordings: [{
          id: "84c3db91-a0a0-41dc-a39a-c9e20ec985c8",
          title: "Song",
          artists: [{ name: "Artist" }],
          releasegroups: [{ id: "5fc76517-4ba0-4a11-9e27-6f266758c19c", title: "Album" }],
        }],
      }],
    }), { status: 200 }));
    const lookup = createAcoustIdFingerprintLookup({
      clientKey: "client key + ?",
      executable: "C:\\fpcalc.exe",
      execute,
      request,
      timeoutMs: 50,
    });

    const results = await lookup.search("C:\\music\\song.mp3");

    expect(results[0]).toMatchObject({
      id: "acoustid:84c3db91-a0a0-41dc-a39a-c9e20ec985c8",
      title: "Song",
      artist: "Artist",
      album: "Album",
      score: 0.981,
      source: "fingerprint",
    });
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe("https://api.acoustid.org/v2/lookup");
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("client=client+key+%2B+%3F");
    expect(String(init?.body)).toContain("fingerprint=A_B-C");
    expect(init?.redirect).toBe("error");
  });
});

describe("music recognition routes", () => {
  const roots: string[] = [];
  const databases: DiaryDatabase[] = [];
  const servers: ReturnType<typeof buildServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    databases.splice(0).forEach((database) => database.close());
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it("stores candidates without applying them, then applies only an explicit selection", async () => {
    const context = await createRecognizableEntry(
      roots,
      databases,
      fakeTextLookup([candidate({
        id: "mb-1",
        title: "识别歌曲",
        artist: "识别歌手",
        album: "识别专辑",
        year: 2024,
        score: 0.97,
      })]),
      fakeFingerprintLookup([]),
    );
    servers.push(context.server);

    const recognized = await context.server.inject({
      method: "POST",
      url: `/api/v1/entries/${context.entryId}/music/recognition`,
    });
    expect(recognized.statusCode).toBe(200);
    expect(recognized.json()).toMatchObject({
      recognitionStatus: "candidates",
      candidates: [{ id: "mb-1", title: "识别歌曲" }],
    });
    expect(context.database.prepare("SELECT title FROM entry_music WHERE entry_id = ?").get(context.entryId))
      .toEqual({ title: null });

    const listed = await context.server.inject({
      method: "GET",
      url: `/api/v1/entries/${context.entryId}/music/recognition/candidates`,
    });
    expect(listed.json().items).toHaveLength(1);

    const selected = await context.server.inject({
      method: "POST",
      url: `/api/v1/entries/${context.entryId}/music/recognition/selection`,
      payload: { candidateId: "mb-1" },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      title: "识别歌曲",
      artist: "识别歌手",
      recognitionStatus: "recognized",
    });
    expect(new EntryRepository(context.database).searchPublished("识别歌手").map((entry) => entry.id))
      .toEqual([context.entryId]);
  });

  it("supplements rather than clears useful embedded fields when a selected candidate omits them", async () => {
    const context = await createRecognizableEntry(
      roots,
      databases,
      fakeTextLookup([candidate({
        id: "mb-partial",
        title: "Recognized title",
        artist: "Recognized artist",
        album: null,
        year: null,
        score: 0.97,
      })]),
      fakeFingerprintLookup([]),
    );
    servers.push(context.server);
    context.database.prepare(`
      UPDATE entry_music SET album = 'Embedded album', year = 2018 WHERE entry_id = ?
    `).run(context.entryId);

    await context.server.inject({
      method: "POST",
      url: `/api/v1/entries/${context.entryId}/music/recognition`,
    });
    const selected = await context.server.inject({
      method: "POST",
      url: `/api/v1/entries/${context.entryId}/music/recognition/selection`,
      payload: { candidateId: "mb-partial" },
    });

    expect(selected.json()).toMatchObject({
      title: "Recognized title",
      artist: "Recognized artist",
      album: "Embedded album",
      year: 2018,
    });
  });

  it("keeps manual overrides authoritative across later candidate selection and search", async () => {
    const context = await createRecognizableEntry(
      roots,
      databases,
      fakeTextLookup([candidate({
        id: "mb-2",
        title: "Remote title",
        artist: "Remote artist",
        album: "Remote album",
        score: 0.98,
      })]),
      fakeFingerprintLookup([]),
    );
    servers.push(context.server);
    await context.server.inject({
      method: "POST",
      url: `/api/v1/entries/${context.entryId}/music/recognition`,
    });

    const corrected = await context.server.inject({
      method: "PATCH",
      url: `/api/v1/entries/${context.entryId}/music/metadata`,
      payload: { title: "我的歌", artist: "手动歌手", album: null, year: 2025 },
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({
      title: "我的歌",
      artist: "手动歌手",
      album: null,
      year: 2025,
      recognitionStatus: "manual",
    });

    const selected = await context.server.inject({
      method: "POST",
      url: `/api/v1/entries/${context.entryId}/music/recognition/selection`,
      payload: { candidateId: "mb-2" },
    });
    expect(selected.json()).toMatchObject({
      title: "我的歌",
      artist: "手动歌手",
      album: null,
      year: 2025,
    });
    expect(new EntryRepository(context.database).searchPublished("手动歌手").map((entry) => entry.id))
      .toEqual([context.entryId]);
    expect(new EntryRepository(context.database).searchPublished("Remote artist")).toEqual([]);

    new EntryRepository(context.database).updatePublished(context.entryId, {
      title: "Edited entry",
      markdown: "Still a song",
      tags: [],
    });
    expect(new EntryRepository(context.database).searchPublished("手动歌手").map((entry) => entry.id))
      .toEqual([context.entryId]);

    await context.server.inject({
      method: "PATCH",
      url: `/api/v1/entries/${context.entryId}/music/metadata`,
      payload: { artist: null },
    });
    new EntryRepository(context.database).updatePublished(context.entryId, {
      title: "Edited again",
      markdown: "Still a song",
      tags: [],
    });
    expect(context.database.prepare("SELECT song_artist FROM entry_search WHERE entry_id = ?")
      .get(context.entryId)).toEqual({ song_artist: "" });
  });

  it("returns manual_required when recognition is unavailable and rejects invalid candidate selection", async () => {
    const text: TextLookup = { search: async () => { throw new Error("offline"); } };
    const fingerprint: FingerprintLookup = { search: async () => [] };
    const context = await createRecognizableEntry(roots, databases, text, fingerprint);
    servers.push(context.server);

    const recognized = await context.server.inject({
      method: "POST",
      url: `/api/v1/entries/${context.entryId}/music/recognition`,
    });
    expect(recognized.statusCode).toBe(200);
    expect(recognized.json()).toMatchObject({
      recognitionStatus: "manual_required",
      candidates: [],
    });

    const invalid = await context.server.inject({
      method: "POST",
      url: `/api/v1/entries/${context.entryId}/music/recognition/selection`,
      payload: { candidateId: "missing" },
    });
    expect(invalid.statusCode).toBe(422);
  });

  it("validates manual override fields and missing music", async () => {
    const context = await createRecognizableEntry(
      roots,
      databases,
      fakeTextLookup([]),
      fakeFingerprintLookup([]),
    );
    servers.push(context.server);

    const invalid = await context.server.inject({
      method: "PATCH",
      url: `/api/v1/entries/${context.entryId}/music/metadata`,
      payload: { year: 10000, unknown: "field" },
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await context.server.inject({
      method: "POST",
      url: "/api/v1/entries/00000000-0000-4000-8000-000000000000/music/recognition",
    });
    expect(missing.statusCode).toBe(404);
  });
});

function candidate(overrides: Partial<RecognitionCandidate> = {}): RecognitionCandidate {
  return {
    id: "candidate",
    title: null,
    artist: null,
    album: null,
    year: null,
    coverMediaId: null,
    coverReleaseId: null,
    score: 0.5,
    source: "text",
    ...overrides,
  };
}

function fakeTextLookup(candidates: RecognitionCandidate[]): TextLookup & { calls: number } {
  return {
    calls: 0,
    async search() {
      this.calls += 1;
      return candidates;
    },
  };
}

function fakeFingerprintLookup(candidates: RecognitionCandidate[]): FingerprintLookup & {
  calls: number;
  filePaths: string[];
} {
  return {
    calls: 0,
    filePaths: [],
    async search(filePath) {
      this.calls += 1;
      this.filePaths.push(filePath);
      return candidates;
    },
  };
}

async function createRecognizableEntry(
  roots: string[],
  databases: DiaryDatabase[],
  textLookup: TextLookup,
  fingerprintLookup: FingerprintLookup,
) {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-recognition-"));
  const database = createDiaryDatabase(dataRoot);
  roots.push(dataRoot);
  databases.push(database);
  const entries = new EntryRepository(database);
  const draft = entries.saveDraft({ title: "Song", markdown: "A song", tags: [] });
  const entry = entries.publishDraft(draft.id, "2026-07-26T08:00:00.000Z");
  const music = new MusicService(database, new MediaStore(path.join(dataRoot, "media")));
  await music.attach(entry.id, realMp3(), "..\\odd ?# [mix].mp3");
  const server = buildServer({
    dataRoot,
    database,
    musicRecognition: { textLookup, fingerprintLookup },
  });
  return { dataRoot, database, entryId: entry.id, server };
}

function realMp3(): Buffer {
  return Buffer.from(
    "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAwAAAAAAAAAAAAAAD/4zjAAAAAAAAAAAAASW5mbwAAAA8AAAAAAAAA2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAAAAAAAAAAAAAANgAAPVdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "base64",
  );
}
