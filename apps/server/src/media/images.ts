import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import type { DiaryDatabase } from "../db/client.js";
import { MediaStore, type StoredMedia } from "./store.js";

const DISPLAY_WIDTH = 1920;
const THUMBNAIL_WIDTH = 480;

const supportedImageTypes = {
  "image/avif": { extension: "avif", format: "heif" },
  "image/gif": { extension: "gif", format: "gif" },
  "image/jpeg": { extension: "jpg", format: "jpeg" },
  "image/png": { extension: "png", format: "png" },
  "image/tif": { extension: "tiff", format: "tiff" },
  "image/tiff": { extension: "tiff", format: "tiff" },
  "image/webp": { extension: "webp", format: "webp" },
} as const;

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

export class ImageValidationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 415 | 422,
  ) {
    super(message);
  }
}

export class ImageService {
  constructor(
    private readonly database: DiaryDatabase,
    private readonly store: MediaStore,
  ) {}

  async ingest(entryId: string, stream: Readable, mime: string): Promise<ImageIngestionResult> {
    if (!this.database.prepare("SELECT 1 FROM entries WHERE id = ?").get(entryId)) {
      throw new ImageEntryNotFoundError(`Entry ${entryId} was not found`);
    }

    const imageType = imageTypeForMime(mime);
    const bytes = await readStream(stream);
    await validateImage(bytes, imageType.format);
    let derivatives: { display: Buffer; thumbnail: Buffer } | null = null;
    let derivativeError: unknown = null;
    try {
      derivatives = await deriveImage(bytes, normalizeMime(mime));
    } catch (error) {
      derivativeError = error;
    }

    const hashes = [this.store.hash(bytes)];
    if (derivatives) {
      hashes.push(this.store.hash(derivatives.display), this.store.hash(derivatives.thumbnail));
    }
    return this.store.withObjectLocks(hashes, async () => this.persistIngestion(
      entryId,
      bytes,
      imageType.extension,
      normalizeMime(mime),
      derivatives,
      derivativeError,
    ));
  }

  private async persistIngestion(
    entryId: string,
    bytes: Buffer,
    originalExtension: string,
    mime: string,
    derivatives: { display: Buffer; thumbnail: Buffer } | null,
    derivativeError: unknown,
  ): Promise<ImageIngestionResult> {
    const original = await this.store.put(bytes, originalExtension);
    const mediaId = randomUUID();
    const now = new Date().toISOString();
    try {
      this.database.prepare(`
        INSERT INTO media (
          id, entry_id, original_hash, original_mime, original_extension,
          display_hash, thumbnail_hash, derivative_status, derivative_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, ?, ?)
      `).run(mediaId, entryId, original.hash, mime, originalExtension, now, now);
    } catch (error) {
      await this.removeUnreferenced([original]);
      throw error;
    }

    if (!derivatives) return this.recordDerivativeFailure(mediaId, original, derivativeError);

    const createdDerivatives: StoredMedia[] = [];
    let display: StoredMedia;
    let thumbnail: StoredMedia;
    try {
      display = await this.store.put(derivatives.display, "webp");
      if (display.created) createdDerivatives.push(display);
      thumbnail = await this.store.put(derivatives.thumbnail, "webp");
      if (thumbnail.created) createdDerivatives.push(thumbnail);
    } catch (error) {
      await this.removeUnreferenced(createdDerivatives);
      return this.recordDerivativeFailure(mediaId, original, error);
    }

    try {
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
      await this.removeUnreferenced(createdDerivatives);
      throw error;
    }
  }

  private recordDerivativeFailure(
    mediaId: string,
    original: StoredMedia,
    error: unknown,
  ): ImageIngestionResult {
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

  private async removeUnreferenced(objects: StoredMedia[]): Promise<void> {
    await Promise.all(objects.filter((object) => object.created).map(async (object) => {
      const referenced = this.database.prepare(`
        SELECT 1 FROM media
        WHERE original_hash = ? OR display_hash = ? OR thumbnail_hash = ?
        LIMIT 1
      `).get(object.hash, object.hash, object.hash);
      if (!referenced) await this.store.remove(object.path);
    }));
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

export function isSupportedImageMime(mime: string): boolean {
  return normalizeMime(mime) in supportedImageTypes;
}

function imageTypeForMime(mime: string) {
  const normalizedMime = normalizeMime(mime);
  const imageType = supportedImageTypes[normalizedMime as keyof typeof supportedImageTypes];
  if (!imageType) throw new ImageValidationError("Unsupported image MIME type", 415);
  return imageType;
}

function normalizeMime(mime: string): string {
  return mime.trim().toLowerCase();
}

async function validateImage(bytes: Buffer, expectedFormat: string): Promise<void> {
  try {
    const metadata = await sharp(bytes).metadata();
    if (metadata.format !== expectedFormat) {
      throw new ImageValidationError("Image bytes do not match the declared MIME type", 422);
    }
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    throw new ImageValidationError("Uploaded bytes are not a valid image", 422);
  }
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
