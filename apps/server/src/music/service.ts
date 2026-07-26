import { randomUUID } from "node:crypto";
import type { DiaryDatabase } from "../db/client.js";
import { MediaStore, type StoredMedia } from "../media/store.js";
import { isMp3Container, readId3, type MusicMetadata } from "./id3.js";

export type AttachedMusic = Omit<MusicMetadata, "coverBytes"> & {
  mediaId: string;
  originalHash: string;
  originalPath: string;
  coverMediaId: string | null;
  coverPath: string | null;
  originalFilename: string;
};

export class MusicEntryNotFoundError extends Error {
  constructor() { super("ENTRY_NOT_FOUND"); }
}

export class MusicAlreadyAttachedError extends Error {
  constructor() { super("ENTRY_ALREADY_HAS_MUSIC"); }
}

export class MusicValidationError extends Error {
  constructor(message: string, readonly statusCode: 415 | 422 = 422) { super(message); }
}

export class MusicService {
  constructor(
    private readonly database: DiaryDatabase,
    private readonly store: MediaStore,
  ) {}

  async attach(entryId: string, bytes: Buffer, filename = "track.mp3"): Promise<AttachedMusic> {
    this.assertAttachableEntry(entryId);
    if (!(await isMp3Container(bytes))) throw new MusicValidationError("Uploaded bytes are not a valid MP3");

    const metadata = await readId3(bytes);
    const coverExtensionName = metadata.coverMime ? coverExtension(metadata.coverMime) : null;
    const cover = metadata.coverBytes && metadata.coverMime && coverExtensionName ? {
      bytes: metadata.coverBytes,
      mime: metadata.coverMime,
      extension: coverExtensionName,
    } : null;
    if (metadata.coverBytes && !cover) {
      metadata.coverBytes = null;
      metadata.coverMime = null;
      if (!metadata.title && !metadata.artist && !metadata.album && !metadata.year) {
        metadata.recognitionStatus = "manual_required";
      }
    }
    const hashes = [this.store.hash(bytes), ...(cover ? [this.store.hash(cover.bytes)] : [])];
    return this.store.withObjectLocks(
      hashes,
      async () => this.persist(entryId, bytes, metadata, cover, normalizeFilename(filename)),
    );
  }

  private assertAttachableEntry(entryId: string): void {
    const entry = this.database.prepare("SELECT state FROM entries WHERE id = ?").get(entryId) as { state: string } | undefined;
    if (!entry || entry.state === "trashed") throw new MusicEntryNotFoundError();
  }

  private async persist(
    entryId: string,
    bytes: Buffer,
    metadata: MusicMetadata,
    cover: { bytes: Buffer; mime: string; extension: string } | null,
    filename: string,
  ): Promise<AttachedMusic> {
    const original = await this.store.put(bytes, "mp3");
    let coverStored: StoredMedia | null = null;
    try {
      if (cover) coverStored = await this.store.put(cover.bytes, cover.extension);
      const musicId = randomUUID();
      const coverId = coverStored ? randomUUID() : null;
      const now = new Date().toISOString();
      try {
        this.database.transaction(() => {
          this.assertAttachableEntry(entryId);
          if (this.database.prepare("SELECT 1 FROM entry_music WHERE entry_id = ?").get(entryId)) {
            throw new MusicAlreadyAttachedError();
          }
          this.database.prepare(`
            INSERT INTO media (id, entry_id, original_hash, original_mime, original_extension, display_hash, thumbnail_hash, derivative_status, derivative_error, created_at, updated_at)
            VALUES (?, ?, ?, 'audio/mpeg', 'mp3', NULL, NULL, 'failed', 'not applicable', ?, ?)
          `).run(musicId, entryId, original.hash, now, now);
          if (coverStored && coverId && cover) {
            this.database.prepare(`
              INSERT INTO media (id, entry_id, original_hash, original_mime, original_extension, display_hash, thumbnail_hash, derivative_status, derivative_error, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, NULL, NULL, 'failed', 'not applicable', ?, ?)
            `).run(coverId, entryId, coverStored.hash, cover.mime, cover.extension, now, now);
          }
          this.database.prepare(`
            INSERT INTO entry_music (
              entry_id, media_id, title, artist, album, year, cover_media_id,
              recognition_status, original_filename
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            entryId,
            musicId,
            metadata.title,
            metadata.artist,
            metadata.album,
            metadata.year,
            coverId,
            metadata.recognitionStatus,
            filename,
          );
          this.database.prepare(`
            UPDATE entry_search SET song_title = ?, song_artist = ?, song_album = ? WHERE entry_id = ?
          `).run(metadata.title ?? "", metadata.artist ?? "", metadata.album ?? "", entryId);
        })();
      } catch (error) {
        await this.removeUnreferenced([original, ...(coverStored ? [coverStored] : [])]);
        throw error;
      }
      return {
        mediaId: musicId,
        originalHash: original.hash,
        originalPath: original.path,
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        year: metadata.year,
        coverMime: cover?.mime ?? null,
        coverMediaId: coverId,
        coverPath: coverStored?.path ?? null,
        recognitionStatus: metadata.recognitionStatus,
        originalFilename: filename,
      };
    } catch (error) {
      if (!coverStored) await this.removeUnreferenced([original]);
      throw error;
    }
  }

  private async removeUnreferenced(objects: StoredMedia[]): Promise<void> {
    await Promise.all(objects.filter((object) => object.created).map(async (object) => {
      const referenced = this.database.prepare("SELECT 1 FROM media WHERE original_hash = ? LIMIT 1").get(object.hash);
      if (!referenced) await this.store.remove(object.path);
    }));
  }
}

function normalizeFilename(filename: string): string {
  const normalized = filename
    .replaceAll("\0", "")
    .replace(/^.*[\\/]/, "")
    .trim()
    .slice(0, 255);
  return normalized || "track.mp3";
}

function coverExtension(mime: string): string | null {
  const extensions: Record<string, string> = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/tiff": "tiff",
    "image/webp": "webp",
  };
  return extensions[mime] ?? null;
}
