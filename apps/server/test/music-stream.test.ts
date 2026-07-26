import { mkdtempSync, rmSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { createDiaryDatabase } from "../src/db/client.js";
import { EntryRepository } from "../src/entries/repository.js";
import { MediaStore } from "../src/media/store.js";
import { MusicService } from "../src/music/service.js";

describe("MP3 streaming", () => {
  const roots: string[] = [];
  const servers: ReturnType<typeof buildServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  async function seed() {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-stream-"));
    roots.push(dataRoot);
    const database = createDiaryDatabase(dataRoot);
    const mediaStore = new MediaStore(path.join(dataRoot, "media"));
    const entries = new EntryRepository(database);
    const draft = entries.saveDraft({ title: "Song", markdown: "Still readable", tags: [] });
    const entry = entries.publishDraft(draft.id, "2026-07-26T08:00:00.000Z");
    const attached = await new MusicService(database, mediaStore).attach(entry.id, realMp3(), "song.mp3");
    const server = buildServer({ dataRoot, database });
    servers.push(server);
    return { attached, database, entry, server };
  }

  it("streams the complete MP3 without buffering it into a JSON response", async () => {
    const { attached, server } = await seed();

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/music/${attached.mediaId}/stream`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "accept-ranges": "bytes",
      "content-length": String(realMp3().length),
      "content-type": "audio/mpeg",
    });
    expect(response.rawPayload).toEqual(realMp3());
  });

  it("includes effective music metadata and stable media URLs in diary entries", async () => {
    const { attached, entry, server } = await seed();

    const response = await server.inject({ method: "GET", url: "/api/v1/entries" });
    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({
      id: entry.id,
      music: {
        mediaId: attached.mediaId,
        title: null,
        originalFilename: "song.mp3",
        streamUrl: `/api/v1/music/${attached.mediaId}/stream`,
        coverUrl: null,
        available: true,
      },
    });
  });

  it("serves byte ranges and rejects malformed, multiple, and unsatisfiable ranges", async () => {
    const { attached, server } = await seed();
    const url = `/api/v1/music/${attached.mediaId}/stream`;

    const partial = await server.inject({
      method: "GET",
      url,
      headers: { range: "bytes=3-11" },
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers).toMatchObject({
      "accept-ranges": "bytes",
      "content-length": "9",
      "content-range": `bytes 3-11/${realMp3().length}`,
    });
    expect(partial.rawPayload).toEqual(realMp3().subarray(3, 12));

    for (const range of ["bytes=999999-", "bytes=3-2", "bytes=0-1,4-5", "items=0-1"]) {
      const invalid = await server.inject({ method: "GET", url, headers: { range } });
      expect(invalid.statusCode).toBe(416);
      expect(invalid.headers["content-range"]).toBe(`bytes */${realMp3().length}`);
    }
  });

  it("supports HEAD and never serves another attachment or trashed entry", async () => {
    const { attached, database, entry, server } = await seed();
    const url = `/api/v1/music/${attached.mediaId}/stream`;

    const head = await server.inject({ method: "HEAD", url });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe(String(realMp3().length));
    expect(head.rawPayload).toHaveLength(0);

    const entries = new EntryRepository(database);
    const secondDraft = entries.saveDraft({ title: "Other", markdown: "Other entry", tags: [] });
    const second = entries.publishDraft(secondDraft.id, "2026-07-26T09:00:00.000Z");
    database.prepare("UPDATE media SET entry_id = ? WHERE id = ?")
      .run(second.id, attached.mediaId);
    const unowned = await server.inject({ method: "GET", url });
    expect(unowned.statusCode).toBe(404);

    database.prepare("UPDATE media SET entry_id = ? WHERE id = ?").run(entry.id, attached.mediaId);
    database.prepare("UPDATE entries SET state = 'trashed' WHERE id = ?").run(entry.id);
    const trashed = await server.inject({ method: "GET", url });
    expect(trashed.statusCode).toBe(404);
  });

  it("returns a safe unavailable response for missing or corrupt stored objects", async () => {
    const { attached, server } = await seed();
    const url = `/api/v1/music/${attached.mediaId}/stream`;

    await writeFile(attached.originalPath, Buffer.from("not an MP3"));
    const corrupt = await server.inject({ method: "GET", url });
    expect(corrupt.statusCode).toBe(422);
    expect(corrupt.json()).toEqual({ error: "MEDIA UNAVAILABLE" });
    const entries = await server.inject({ method: "GET", url: "/api/v1/entries" });
    expect(entries.json()[0]).toMatchObject({
      markdown: "Still readable",
      music: { available: false },
    });

    await writeFile(attached.originalPath, Buffer.alloc(0));
    const empty = await server.inject({ method: "GET", url });
    expect(empty.statusCode).toBe(422);
    expect(empty.json()).toEqual({ error: "MEDIA UNAVAILABLE" });

    await rm(attached.originalPath);
    const missing = await server.inject({ method: "GET", url });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toEqual({ error: "MEDIA UNAVAILABLE" });
  });
});

function realMp3(): Buffer {
  return Buffer.from(
    "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAwAAAAAAAAAAAAAAD/4zjAAAAAAAAAAAAASW5mbwAAAA8AAAAAAAAA2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAAAAAAAAAAAAAANgAAPVdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "base64",
  );
}
