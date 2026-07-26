import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import sharp from "sharp";
import type { DiaryDatabase } from "../db/client.js";
import { MediaStore } from "./store.js";

const DISPLAY_WIDTH = 1920;
const THUMBNAIL_WIDTH = 480;

export type DerivativeStatus = "ready" | "failed";

export type ImageIngestionResult = {
  mediaId: string;
  originalHash: string;
  originalPath: string;
  displayPath: string | null;
  thumbnailPath: string | null;
  derivativeStatus: DerivativeStatus;
  derivativeError: string | null;
};

export class ImageEntryNotFoundError extends Error {}

export class ImageService {
  constructor(
    private readonly database: DiaryDatabase,
    private readonly store: MediaStore,
  ) {}

  async ingest(entryId: string, stream: Readable, mime: string): Promise<ImageIngestionResult> {
    if (!this.database.prepare("SELECT 1 FROM entries WHERE id = ?").get(entryId)) {
      throw new ImageEntryNotFoundError(`Entry ${entryId} was not found`);
    }

    const original = await this.store.put(stream, extensionForMime(mime));
    const mediaId = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO media (
        id, entry_id, original_hash, original_mime, original_extension,
        display_hash, thumbnail_hash, derivative_status, derivative_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, ?, ?)
    `).run(mediaId, entryId, original.hash, mime, extensionForMime(mime), now, now);

    try {
      const bytes = await readFile(original.path);
      const derivatives = await deriveImage(bytes, mime);
      const display = await this.store.put(derivatives.display, "webp");
      const thumbnail = await this.store.put(derivatives.thumbnail, "webp");
      this.database.prepare(`
        UPDATE media
        SET display_hash = ?, thumbnail_hash = ?, derivative_status = 'ready', updated_at = ?
        WHERE id = ?
      `).run(display.hash, thumbnail.hash, new Date().toISOString(), mediaId);
      return {
        mediaId,
        originalHash: original.hash,
        originalPath: original.path,
        displayPath: display.path,
        thumbnailPath: thumbnail.path,
        derivativeStatus: "ready",
        derivativeError: null,
      };
    } catch (error) {
      const derivativeError = error instanceof Error ? error.message : String(error);
      this.database.prepare(`
        UPDATE media SET derivative_status = 'failed', derivative_error = ?, updated_at = ? WHERE id = ?
      `).run(derivativeError, new Date().toISOString(), mediaId);
      return {
        mediaId,
        originalHash: original.hash,
        originalPath: original.path,
        displayPath: null,
        thumbnailPath: null,
        derivativeStatus: "failed",
        derivativeError,
      };
    }
  }
}

export async function deriveImage(original: Buffer, mime: string): Promise<{ display: Buffer; thumbnail: Buffer }> {
  if (mime === "image/tiff" || mime === "image/tif") {
    throw new Error("TIFF image derivatives are not supported");
  }
  return {
    display: await sharp(original)
      .rotate()
      .resize({ width: DISPLAY_WIDTH, withoutEnlargement: true })
      .webp({ quality: 86 })
      .toBuffer(),
    thumbnail: await sharp(original)
      .rotate()
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer(),
  };
}

function extensionForMime(mime: string): string {
  const extensions: Record<string, string> = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/tif": "tiff",
    "image/tiff": "tiff",
    "image/webp": "webp",
  };
  return extensions[mime] ?? "bin";
}
