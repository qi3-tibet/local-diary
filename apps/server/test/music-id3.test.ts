import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { createDiaryDatabase, type DiaryDatabase } from "../src/db/client.js";
import { EntryRepository } from "../src/entries/repository.js";
import { MediaStore } from "../src/media/store.js";
import { readId3 } from "../src/music/id3.js";
import { MusicService } from "../src/music/service.js";

describe("MP3 ingestion", () => {
  const dataRoots: string[] = [];
  const databases: DiaryDatabase[] = [];
  const servers: ReturnType<typeof buildServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    databases.splice(0).forEach((database) => database.close());
    dataRoots.splice(0).forEach((dataRoot) => rmSync(dataRoot, { recursive: true, force: true }));
  });

  function createMusicService() {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-music-"));
    const database = createDiaryDatabase(dataRoot);
    const entries = new EntryRepository(database);
    const draft = entries.saveDraft({ title: "Song", markdown: "A song", tags: [] });
    const entry = entries.publishDraft(draft.id, "2026-07-26T08:00:00.000Z");
    dataRoots.push(dataRoot);
    databases.push(database);
    return {
      dataRoot,
      database,
      entry,
      musicService: new MusicService(database, new MediaStore(path.join(dataRoot, "media"))),
    };
  }

  it("reads embedded song fields and cover without rewriting the MP3", async () => {
    const { entry, musicService } = createMusicService();
    const bytes = taggedMp3();

    const attached = await musicService.attach(entry.id, bytes);

    expect(attached).toMatchObject({
      title: "Pink + White",
      artist: "Frank Ocean",
      album: "Blonde",
      year: 2016,
      recognitionStatus: "embedded",
      coverMime: "image/png",
    });
    expect(await readFile(attached.originalPath)).toEqual(bytes);
    expect(await readFile(attached.coverPath!)).toEqual(pngCover());
    await expect(musicService.attach(entry.id, bytes)).rejects.toThrow("ENTRY_ALREADY_HAS_MUSIC");
  });

  it("allows valid MP3s with missing or corrupt ID3 fields", async () => {
    const { entry, musicService } = createMusicService();

    const attached = await musicService.attach(entry.id, realMp3());

    expect(attached).toMatchObject({
      title: null,
      artist: null,
      album: null,
      year: null,
      coverPath: null,
      recognitionStatus: "manual_required",
    });
    await expect(readId3(corruptTaggedMp3())).resolves.toMatchObject({
      title: null,
      artist: null,
      album: null,
      year: null,
      recognitionStatus: "manual_required",
    });
  });

  it("rejects fake MP3 bytes before objects or database rows are created", async () => {
    const { dataRoot, database, entry, musicService } = createMusicService();

    await expect(musicService.attach(entry.id, Buffer.from("not an MP3")))
      .rejects.toThrow("Uploaded bytes are not a valid MP3");

    expect(database.prepare("SELECT COUNT(*) AS count FROM media").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM entry_music").get()).toEqual({ count: 0 });
    expect(existsSync(path.join(dataRoot, "media"))).toBe(false);
  });

  it("rejects two correctly spaced fake MPEG headers in random bytes", async () => {
    const { entry, musicService } = createMusicService();

    await expect(musicService.attach(entry.id, twoHeaderSpoof()))
      .rejects.toThrow("Uploaded bytes are not a valid MP3");
  });

  it("accepts a generated real MP3 fixture", async () => {
    const { entry, musicService } = createMusicService();

    await expect(musicService.attach(entry.id, realMp3())).resolves.toMatchObject({
      recognitionStatus: "manual_required",
    });
  });

  it("does not persist APIC bytes that only claim to be an image", async () => {
    const { dataRoot, entry, musicService } = createMusicService();

    const attached = await musicService.attach(entry.id, taggedMp3(Buffer.from("not an image"), "image/png"));

    expect(attached).toMatchObject({
      title: "Pink + White",
      coverMime: null,
      coverMediaId: null,
      coverPath: null,
    });
    expect(await objectCount(dataRoot)).toBe(1);
  });

  it("does not attach music to missing or trashed entries", async () => {
    const { database, entry, musicService } = createMusicService();

    await expect(musicService.attach("missing", realMp3())).rejects.toThrow("ENTRY_NOT_FOUND");
    database.prepare("UPDATE entries SET state = 'trashed' WHERE id = ?").run(entry.id);
    await expect(musicService.attach(entry.id, realMp3())).rejects.toThrow("ENTRY_NOT_FOUND");
  });

  it("enforces one track when two attachments race", async () => {
    const { database, entry, musicService } = createMusicService();
    const [left, right] = await Promise.allSettled([
      musicService.attach(entry.id, realMp3()),
      musicService.attach(entry.id, taggedMp3()),
    ]);

    expect([left, right].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect([left, right].filter((result) => result.status === "rejected")[0]?.reason.message)
      .toBe("ENTRY_ALREADY_HAS_MUSIC");
    expect(database.prepare("SELECT COUNT(*) AS count FROM entry_music").get()).toEqual({ count: 1 });
  });

  it("keeps draft-attached metadata in the published search index", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-music-draft-"));
    const database = createDiaryDatabase(dataRoot);
    const entries = new EntryRepository(database);
    const draft = entries.saveDraft({ title: "Song", markdown: "A song", tags: [] });
    dataRoots.push(dataRoot);
    databases.push(database);
    const musicService = new MusicService(database, new MediaStore(path.join(dataRoot, "media")));

    await musicService.attach(draft.id, taggedMp3());
    entries.publishDraft(draft.id, "2026-07-26T08:00:00.000Z");

    expect(entries.searchPublished("Frank Ocean").map((entry) => entry.id)).toEqual([draft.id]);
  });

  it("cleans newly written media when the attachment transaction fails", async () => {
    const { dataRoot, database, entry, musicService } = createMusicService();
    database.exec(`
      CREATE TRIGGER reject_music
      BEFORE INSERT ON entry_music
      BEGIN SELECT RAISE(ABORT, 'music rejected'); END;
    `);

    await expect(musicService.attach(entry.id, taggedMp3())).rejects.toThrow("music rejected");

    expect(database.prepare("SELECT COUNT(*) AS count FROM media").get()).toEqual({ count: 0 });
    expect(await objectCount(dataRoot)).toBe(0);
  });

  it("accepts one valid MP3 through POST and PATCH multipart endpoints", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-music-route-"));
    dataRoots.push(dataRoot);
    const server = buildServer({ dataRoot });
    servers.push(server);
    await server.inject({
      method: "PUT",
      url: "/api/v1/draft",
      payload: { title: "Song", markdown: "A song", tags: [] },
    });
    const entry = await server.inject({ method: "POST", url: "/api/v1/draft/publish" });
    const url = `/api/v1/entries/${entry.json().id}/music`;

    const upload = await server.inject(multipartRequest("POST", url, taggedMp3(), "audio/mpeg", "track.mp3"));
    const second = await server.inject(multipartRequest("PATCH", url, realMp3(), "audio/mpeg", "second.mp3"));

    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({ title: "Pink + White", artist: "Frank Ocean", coverMime: "image/png" });
    expect(second.statusCode).toBe(409);
  });

  it("rejects spoofed multipart audio without artifacts", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-music-route-"));
    dataRoots.push(dataRoot);
    const database = createDiaryDatabase(dataRoot);
    databases.push(database);
    const server = buildServer({ dataRoot, database });
    servers.push(server);
    const entries = new EntryRepository(database);
    const draft = entries.saveDraft({ title: "Song", markdown: "A song", tags: [] });
    const entry = entries.publishDraft(draft.id, "2026-07-26T08:00:00.000Z");

    const response = await server.inject(multipartRequest(
      "POST",
      `/api/v1/entries/${entry.id}/music`,
      Buffer.from("not an MP3"),
      "audio/mpeg",
      "spoof.mp3",
    ));

    expect(response.statusCode).toBe(422);
    expect(database.prepare("SELECT COUNT(*) AS count FROM media").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM entry_music").get()).toEqual({ count: 0 });
    expect(existsSync(path.join(dataRoot, "media"))).toBe(false);
  });

  it("enforces its endpoint-specific multipart size limit without artifacts", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-music-limit-"));
    const database = createDiaryDatabase(dataRoot);
    const entries = new EntryRepository(database);
    const draft = entries.saveDraft({ title: "Song", markdown: "A song", tags: [] });
    const entry = entries.publishDraft(draft.id, "2026-07-26T08:00:00.000Z");
    const server = buildServer({ dataRoot, database, musicUploadLimit: 128 });
    dataRoots.push(dataRoot);
    databases.push(database);
    servers.push(server);

    const response = await server.inject(multipartRequest(
      "POST",
      `/api/v1/entries/${entry.id}/music`,
      realMp3(),
      "audio/mpeg",
      "too-large.mp3",
    ));

    expect(response.statusCode).toBe(413);
    expect(database.prepare("SELECT COUNT(*) AS count FROM media").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM entry_music").get()).toEqual({ count: 0 });
    expect(existsSync(path.join(dataRoot, "media"))).toBe(false);
  });

  it("rejects multipart requests with extra fields", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-music-parts-"));
    const database = createDiaryDatabase(dataRoot);
    const entries = new EntryRepository(database);
    const draft = entries.saveDraft({ title: "Song", markdown: "A song", tags: [] });
    const entry = entries.publishDraft(draft.id, "2026-07-26T08:00:00.000Z");
    const server = buildServer({ dataRoot, database });
    dataRoots.push(dataRoot);
    databases.push(database);
    servers.push(server);

    const response = await server.inject(multipartPartsRequest(`/api/v1/entries/${entry.id}/music`, [
      { type: "file", bytes: realMp3(), mime: "audio/mpeg", filename: "first.mp3" },
      { type: "field", value: "unexpected" },
    ]));

    expect(response.statusCode).toBe(400);
    expect(database.prepare("SELECT COUNT(*) AS count FROM media").get()).toEqual({ count: 0 });
  });

  it("rejects multipart requests with a second MP3 file", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-music-parts-"));
    const database = createDiaryDatabase(dataRoot);
    const entries = new EntryRepository(database);
    const draft = entries.saveDraft({ title: "Song", markdown: "A song", tags: [] });
    const entry = entries.publishDraft(draft.id, "2026-07-26T08:00:00.000Z");
    const server = buildServer({ dataRoot, database });
    dataRoots.push(dataRoot);
    databases.push(database);
    servers.push(server);

    const response = await server.inject(multipartPartsRequest(`/api/v1/entries/${entry.id}/music`, [
      { type: "file", bytes: realMp3(), mime: "audio/mpeg", filename: "first.mp3" },
      { type: "file", bytes: realMp3(), mime: "audio/mpeg", filename: "second.mp3" },
    ]));

    expect(response.statusCode).toBe(400);
    expect(database.prepare("SELECT COUNT(*) AS count FROM media").get()).toEqual({ count: 0 });
  });
});

function multipartRequest(method: "POST" | "PATCH", url: string, bytes: Buffer, mime: string, filename: string) {
  const boundary = "music-upload-boundary";
  return {
    method,
    url,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="music"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function multipartPartsRequest(url: string, parts: Array<
  | { type: "file"; bytes: Buffer; mime: string; filename: string }
  | { type: "field"; value: string }
>) {
  const boundary = "music-upload-parts-boundary";
  const encoded = parts.flatMap((part) => part.type === "file"
    ? [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="music"; filename="${part.filename}"\r\nContent-Type: ${part.mime}\r\n\r\n`),
      part.bytes,
      Buffer.from("\r\n"),
    ]
    : [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\n${part.value}\r\n`)],
  );
  return {
    method: "POST" as const,
    url,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([...encoded, Buffer.from(`--${boundary}--\r\n`)]),
  };
}

function taggedMp3(cover = pngCover(), coverMime = "image/png"): Buffer {
  const frames = [
    textFrame("TIT2", "Pink + White"),
    textFrame("TPE1", "Frank Ocean"),
    textFrame("TALB", "Blonde"),
    textFrame("TYER", "2016"),
    apicFrame(coverMime, cover),
  ];
  const tag = Buffer.concat(frames);
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]), syncSafe(tag.length), tag, realMp3()]);
}

function textFrame(id: string, text: string): Buffer {
  const content = Buffer.concat([Buffer.from([3]), Buffer.from(text, "utf8")]);
  return Buffer.concat([Buffer.from(id), uint32(content.length), Buffer.from([0, 0]), content]);
}

function apicFrame(mime: string, image: Buffer): Buffer {
  const content = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(mime, "latin1"),
    Buffer.from([0, 3, 0]),
    image,
  ]);
  return Buffer.concat([Buffer.from("APIC"), uint32(content.length), Buffer.from([0, 0]), content]);
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function syncSafe(value: number): Buffer {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

function twoHeaderSpoof(): Buffer {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  return Buffer.concat([header, Buffer.alloc(413), header, Buffer.alloc(413)]);
}

function corruptTaggedMp3(): Buffer {
  return Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05]),
    Buffer.from("oops!"),
    realMp3(),
  ]);
}

function realMp3(): Buffer {
  return Buffer.from(
    "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAwAAAAAAAAAAAAAAD/4zjAAAAAAAAAAAAASW5mbwAAAA8AAAAAAAAA2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAAAAAAAAAAAAAANgAAPVdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "base64",
  );
}

function pngCover(): Buffer {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+N3Pm8QAAAABJRU5ErkJggg==", "base64");
}

async function objectCount(dataRoot: string): Promise<number> {
  const root = path.join(dataRoot, "media", "objects");
  if (!existsSync(root)) return 0;
  const directories = await readdir(root);
  const files = await Promise.all(directories.map((directory) => readdir(path.join(root, directory))));
  return files.flat().filter((file) => !file.endsWith(".tmp")).length;
}
