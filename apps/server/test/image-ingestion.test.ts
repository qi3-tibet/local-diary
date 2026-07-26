import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
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
      dataRoot,
      database,
      imageService: new ImageService(database, new MediaStore(path.join(dataRoot, "media"))),
      entry,
    };
  }

  it("rejects media-store extensions that could escape the object directory", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-media-store-"));
    dataRoots.push(dataRoot);
    const store = new MediaStore(path.join(dataRoot, "media"));

    await expect(store.put(Buffer.from("image bytes"), "safe/../../../escape"))
      .rejects.toThrow("Invalid media extension");
    expect(() => store.pathFor("a".repeat(64), "webp.png")).toThrow("Invalid media extension");
  });

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

  it("does not enlarge a small image while generating derivatives", async () => {
    const { imageService, entry } = createImageService();
    const fixture = await sharp({
      create: { width: 320, height: 240, channels: 3, background: "#4f7a67" },
    }).jpeg().toBuffer();

    const result = await imageService.ingest(entry.id, Readable.from(fixture), "image/jpeg");

    expect((await sharp(await readFile(result.displayPath!)).metadata()).width).toBe(320);
    expect((await sharp(await readFile(result.thumbnailPath!)).metadata()).width).toBe(320);
  });

  it("accepts an actual AVIF upload", async () => {
    const { imageService, entry } = createImageService();
    const fixture = await sharp({
      create: { width: 320, height: 240, channels: 3, background: "#4f7a67" },
    }).avif().toBuffer();

    const result = await imageService.ingest(entry.id, Readable.from(fixture), "image/avif");

    expect(result.derivativeStatus).toBe("ready");
  });

  it("stores concurrent identical uploads as one content-addressed object", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-concurrent-store-"));
    dataRoots.push(dataRoot);
    const store = new MediaStore(path.join(dataRoot, "media"));
    const bytes = Buffer.from("same image bytes");

    const [left, right] = await Promise.all([
      store.put(bytes, "jpg"),
      store.put(bytes, "jpg"),
    ]);

    expect(left.path).toBe(right.path);
    expect(Number(left.created) + Number(right.created)).toBe(1);
    expect(await storedObjectCount(dataRoot)).toBe(1);
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

  it("streams a stable display derivative for an uploaded media id", async () => {
    const { entryId, server } = await createRouteServer();
    const fixture = await sharp({
      create: { width: 48, height: 32, channels: 3, background: "#4f7a67" },
    }).png().toBuffer();
    const { boundary, payload } = multipartPayload("image/png", fixture, "field.png");
    const upload = await server.inject({
      method: "POST",
      url: `/api/v1/entries/${entryId}/images`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/media/${upload.json().mediaId}/display`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect((await sharp(response.rawPayload).metadata()).format).toBe("webp");
  });

  it("returns 404 when a display media id does not exist", async () => {
    const { server } = await createRouteServer();

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/media/missing/display",
    });

    expect(response.statusCode).toBe(404);
  });

  it("streams the original when derivative generation failed", async () => {
    const { entryId, server } = await createRouteServer();
    const fixture = await sharp({
      create: { width: 24, height: 16, channels: 3, background: "#4f7a67" },
    }).tiff().toBuffer();
    const { boundary, payload } = multipartPayload("image/tiff", fixture, "scan.tiff");
    const upload = await server.inject({
      method: "POST",
      url: `/api/v1/entries/${entryId}/images`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/media/${upload.json().mediaId}/display`,
    });

    expect(upload.json().derivativeStatus).toBe("failed");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/tiff");
    expect(response.rawPayload).toEqual(fixture);
  });

  it("returns 415 without storing an unsupported declared image type", async () => {
    const { dataRoot, database, entryId, server } = await createRouteServer();
    const { boundary, payload } = multipartPayload("image/svg+xml", Buffer.from("<svg/>"), "image.svg");

    const response = await server.inject({
      method: "POST",
      url: `/api/v1/entries/${entryId}/images`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(415);
    expect(database.prepare("SELECT COUNT(*) AS count FROM media").get()).toEqual({ count: 0 });
    expect(existsSync(path.join(dataRoot, "media"))).toBe(false);
  });

  it("returns 422 without storing bytes that do not match the declared image type", async () => {
    const { dataRoot, database, entryId, server } = await createRouteServer();
    const actualPng = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#4f7a67" },
    }).png().toBuffer();
    const { boundary, payload } = multipartPayload("image/jpeg", actualPng, "spoof.jpg");

    const response = await server.inject({
      method: "POST",
      url: `/api/v1/entries/${entryId}/images`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(422);
    expect(database.prepare("SELECT COUNT(*) AS count FROM media").get()).toEqual({ count: 0 });
    expect(existsSync(path.join(dataRoot, "media"))).toBe(false);
  });

  it("removes a written derivative when a later derivative write fails", async () => {
    const { dataRoot, database, entry } = createImageService();
    const imageService = new ImageService(
      database,
      new FailBeforeThirdWriteStore(path.join(dataRoot, "media")),
    );
    const fixture = await sharp(await readFile(fixturePath("portrait.svg"))).jpeg().toBuffer();

    const result = await imageService.ingest(entry.id, Readable.from(fixture), "image/jpeg");

    expect(result.derivativeStatus).toBe("failed");
    expect(result.derivativeError).toContain("thumbnail write failed");
    expect(await storedObjectCount(dataRoot)).toBe(1);
    expect(database.prepare("SELECT derivative_status FROM media WHERE id = ?").get(result.mediaId))
      .toEqual({ derivative_status: "failed" });
  });

  it("cleans derivative objects and surfaces a database failure while media remains pending", async () => {
    const { dataRoot, database, imageService, entry } = createImageService();
    database.exec(`
      CREATE TRIGGER reject_ready_media
      BEFORE UPDATE OF derivative_status ON media
      WHEN NEW.derivative_status = 'ready'
      BEGIN SELECT RAISE(ABORT, 'ready rejected'); END;
    `);
    const fixture = await sharp(await readFile(fixturePath("portrait.svg"))).jpeg().toBuffer();

    await expect(imageService.ingest(entry.id, Readable.from(fixture), "image/jpeg"))
      .rejects.toThrow("ready rejected");

    expect(await storedObjectCount(dataRoot)).toBe(1);
    expect(database.prepare("SELECT derivative_status FROM media").get())
      .toEqual({ derivative_status: "pending" });
  });

  it("does not delete a concurrent successful upload's shared objects during failed cleanup", async () => {
    const { dataRoot, database, entry } = createImageService();
    const entries = new EntryRepository(database);
    const successDraft = entries.saveDraft({ title: "Second", markdown: "Another picture", tags: [] });
    const successEntry = entries.publishDraft(successDraft.id, "2026-07-26T09:00:00.000Z");
    database.exec(`
      CREATE TRIGGER reject_first_entry_ready
      BEFORE UPDATE OF derivative_status ON media
      WHEN NEW.derivative_status = 'ready'
        AND (SELECT entry_id FROM media WHERE id = NEW.id) = '${entry.id}'
      BEGIN SELECT RAISE(ABORT, 'first entry rejected'); END;
    `);
    const store = new BlockingCleanupStore(path.join(dataRoot, "media"));
    const imageService = new ImageService(database, store);
    const fixture = await sharp({
      create: { width: 320, height: 240, channels: 3, background: "#4f7a67" },
    }).jpeg().toBuffer();

    const failing = imageService.ingest(entry.id, Readable.from(fixture), "image/jpeg");
    await store.waitUntilRemoving();
    const successful = imageService.ingest(successEntry.id, Readable.from(fixture), "image/jpeg");
    const settledBeforeCleanup = await settlesWithin(successful, 500);
    store.releaseCleanup();

    await expect(failing).rejects.toThrow("first entry rejected");
    const success = await successful;
    expect(settledBeforeCleanup).toBe(false);
    expect(success.derivativeStatus).toBe("ready");
    expect(existsSync(success.originalPath)).toBe(true);
    expect(existsSync(success.displayPath!)).toBe(true);
    expect(existsSync(success.thumbnailPath!)).toBe(true);
  });

  async function createRouteServer() {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-images-route-"));
    const database = createDiaryDatabase(dataRoot);
    const server = buildServer({ dataRoot, database });
    dataRoots.push(dataRoot);
    servers.push(server);
    await server.inject({
      method: "PUT",
      url: "/api/v1/draft",
      payload: { title: "Photo", markdown: "A picture", tags: [] },
    });
    const entry = await server.inject({ method: "POST", url: "/api/v1/draft/publish" });
    return { dataRoot, database, entryId: entry.json().id as string, server };
  }

  function multipartPayload(mime: string, bytes: Buffer, filename: string) {
    const boundary = "image-upload-boundary";
    return {
      boundary,
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    };
  }

  async function storedObjectCount(dataRoot: string): Promise<number> {
    const root = path.join(dataRoot, "media", "objects");
    const directories = await readdir(root);
    const files = await Promise.all(directories.map(async (directory) =>
      readdir(path.join(root, directory)),
    ));
    return files.flat().filter((file) => !file.endsWith(".tmp")).length;
  }

  async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    return Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }
});

class FailBeforeThirdWriteStore extends MediaStore {
  private writes = 0;

  override async put(input: Buffer | Readable, extension: string) {
    this.writes += 1;
    if (this.writes === 3) throw new Error("thumbnail write failed");
    return super.put(input, extension);
  }
}

class BlockingCleanupStore extends MediaStore {
  private readonly cleanupStarted: Promise<void>;
  private readonly cleanupReleased: Promise<void>;
  private startCleanup!: () => void;
  private release!: () => void;
  private hasStartedCleanup = false;

  constructor(root: string) {
    super(root);
    this.cleanupStarted = new Promise((resolve) => { this.startCleanup = resolve; });
    this.cleanupReleased = new Promise((resolve) => { this.release = resolve; });
  }

  override async remove(path: string): Promise<void> {
    if (!this.hasStartedCleanup) {
      this.hasStartedCleanup = true;
      this.startCleanup();
    }
    await this.cleanupReleased;
    await super.remove(path);
  }

  waitUntilRemoving(): Promise<void> {
    return this.cleanupStarted;
  }

  releaseCleanup(): void {
    this.release();
  }
}
