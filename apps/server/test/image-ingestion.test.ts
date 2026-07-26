import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { createDiaryDatabase, type DiaryDatabase } from "../src/db/client.js";
import { EntryRepository } from "../src/entries/repository.js";
import { ImageService } from "../src/media/images.js";
import { MediaStore } from "../src/media/store.js";
import { buildServer } from "../src/app.js";

const fixturePath = (name: string) => path.join(import.meta.dirname, "fixtures", name);

describe("image ingestion", () => {
  const dataRoots: string[] = [];
  const databases: DiaryDatabase[] = [];
  const servers: ReturnType<typeof buildServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    databases.splice(0).forEach((database) => database.close());
    dataRoots.splice(0).forEach((dataRoot) => rmSync(dataRoot, { recursive: true, force: true }));
  });

  function createImageService() {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-images-"));
    const database = createDiaryDatabase(dataRoot);
    const entries = new EntryRepository(database);
    const draft = entries.saveDraft({ title: "Photo", markdown: "A picture", tags: [] });
    const entry = entries.publishDraft(draft.id, "2026-07-26T08:00:00.000Z");
    dataRoots.push(dataRoot);
    databases.push(database);
    return {
      database,
      imageService: new ImageService(database, new MediaStore(path.join(dataRoot, "media"))),
      entry,
    };
  }

  it("retains original bytes and creates display plus thumbnail derivatives", async () => {
    const { imageService, entry } = createImageService();
    const fixture = await sharp(await readFile(fixturePath("portrait.svg"))).jpeg({ quality: 90 }).toBuffer();

    const result = await imageService.ingest(entry.id, Readable.from(fixture), "image/jpeg");

    expect(await readFile(result.originalPath)).toEqual(fixture);
    expect(await sharp(await readFile(result.displayPath!)).metadata()).toMatchObject({ width: 1920 });
    expect((await sharp(await readFile(result.thumbnailPath!)).metadata()).width).toBe(480);
    expect(result.originalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.derivativeStatus).toBe("ready");
  });

  it("keeps a valid unsupported original and records a retryable derivative error", async () => {
    const { database, imageService, entry } = createImageService();
    const fixture = await sharp(await readFile(fixturePath("portrait.svg"))).tiff().toBuffer();

    const result = await imageService.ingest(entry.id, Readable.from(fixture), "image/tiff");

    expect(await readFile(result.originalPath)).toEqual(fixture);
    expect(result.derivativeStatus).toBe("failed");
    expect(result.derivativeError).toContain("TIFF");
    expect(result.displayPath).toBeNull();
    expect(result.thumbnailPath).toBeNull();
    expect(database.prepare("SELECT derivative_status FROM media WHERE id = ?").get(result.mediaId))
      .toEqual({ derivative_status: "failed" });
  });

  it("accepts an image through the entry multipart endpoint", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-images-route-"));
    dataRoots.push(dataRoot);
    const server = buildServer({ dataRoot });
    servers.push(server);

    const draft = await server.inject({
      method: "PUT",
      url: "/api/v1/draft",
      payload: { title: "Photo", markdown: "A picture", tags: [] },
    });
    const entry = await server.inject({ method: "POST", url: "/api/v1/draft/publish" });
    const fixture = await sharp(await readFile(fixturePath("portrait.svg"))).jpeg().toBuffer();
    const boundary = "image-upload-boundary";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="portrait.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      fixture,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await server.inject({
      method: "POST",
      url: `/api/v1/entries/${entry.json().id}/images`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(draft.statusCode).toBe(200);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      markdownUrl: expect.stringMatching(/^media:/),
      derivativeStatus: "ready",
    });
  });
});
