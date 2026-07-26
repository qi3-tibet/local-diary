import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
  draftInputSchema,
  type DraftInput,
  type Entry,
  type EntryMusic,
} from "@diary/contracts";
import type { DiaryDatabase } from "../db/client.js";
import type { MediaStore } from "../media/store.js";

type EntryRow = {
  id: string;
  title: string;
  markdown: string;
  state: Entry["state"];
  published_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  edited_at: string | null;
};

export class EntryRepository {
  constructor(
    private readonly db: DiaryDatabase,
    private readonly mediaStore?: MediaStore,
  ) {}

  saveDraft(input: DraftInput): Entry {
    const value = draftInputSchema.parse(input);
    const now = new Date().toISOString();
    const save = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT id FROM entries WHERE state = 'draft'")
        .get() as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();

      if (existing) {
        this.db.prepare(`
          UPDATE entries SET title = ?, markdown = ?, updated_at = ? WHERE id = ?
        `).run(value.title, value.markdown, now, id);
      } else {
        this.db.prepare(`
          INSERT INTO entries (id, title, markdown, state, published_at, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, 'draft', NULL, ?, ?, NULL)
        `).run(id, value.title, value.markdown, now, now);
      }

      this.replaceTags(id, value.tags);
      return id;
    });

    const id = save();
    return this.getById(id)!;
  }

  getDraft(): Entry | null {
    const row = this.db.prepare(`
      SELECT id, title, markdown, state, published_at, created_at, updated_at, deleted_at, edited_at
      FROM entries WHERE state = 'draft'
    `).get() as EntryRow | undefined;
    return row ? this.toEntry(row) : null;
  }

  publishDraft(id: string, publishedAt: string): Entry {
    const publish = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE entries
        SET state = 'published', published_at = ?, updated_at = ?, edited_at = NULL
        WHERE id = ? AND state = 'draft'
      `).run(publishedAt, new Date().toISOString(), id);
      if (result.changes !== 1) throw new Error("Draft not found");
      this.reindex(id);
      return this.getById(id)!;
    });
    return publish();
  }

  listPublished(): Entry[] {
    const rows = this.db.prepare(`
      SELECT id, title, markdown, state, published_at, created_at, updated_at, deleted_at, edited_at
      FROM entries
      WHERE state = 'published'
      ORDER BY published_at DESC
    `).all() as EntryRow[];
    return rows.map((row) => this.toEntry(row));
  }

  listTrashed(): Entry[] {
    const rows = this.db.prepare(`
      SELECT id, title, markdown, state, published_at, created_at, updated_at, deleted_at, edited_at
      FROM entries
      WHERE state = 'trashed'
      ORDER BY deleted_at DESC
    `).all() as EntryRow[];
    return rows.map((row) => this.toEntry(row));
  }

  countByState(state: Entry["state"]): number {
    const result = this.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE state = ?")
      .get(state) as { count: number };
    return result.count;
  }

  updatePublished(id: string, input: DraftInput): Entry | null {
    const value = draftInputSchema.parse(input);
    const update = this.db.transaction(() => {
      const before = this.getPublishedById(id);
      if (!before) return null;
      if (
        before.title === value.title
        && before.markdown === value.markdown
        && this.sameTags(before.tags, value.tags)
      ) return before;
      const now = new Date().toISOString();

      this.db.prepare(`
        UPDATE entries SET title = ?, markdown = ?, updated_at = ?, edited_at = ? WHERE id = ?
      `).run(value.title, value.markdown, now, now, id);
      this.replaceTags(id, value.tags);
      this.reindex(id);

      const after = this.getPublishedById(id)!;
      if (after.publishedAt !== before.publishedAt) throw new Error("published_at changed");
      return after;
    });
    return update();
  }

  trashPublished(id: string, deletedAt = new Date().toISOString()): Entry | null {
    const timestamp = new Date(deletedAt).toISOString();
    const trash = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE entries SET state = 'trashed', deleted_at = ?, updated_at = ?
        WHERE id = ? AND state = 'published'
      `).run(timestamp, timestamp, id);
      return result.changes === 1 ? this.getById(id) : null;
    });
    return trash();
  }

  restoreTrashed(id: string): Entry | null {
    const restore = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE entries SET state = 'published', deleted_at = NULL, updated_at = ?
        WHERE id = ? AND state = 'trashed'
      `).run(new Date().toISOString(), id);
      return result.changes === 1 ? this.getById(id) : null;
    });
    return restore();
  }

  purgeTrashedBefore(cutoff: string): number {
    const purge = this.db.transaction(() => {
      const ids = this.db.prepare(`
        SELECT id FROM entries
        WHERE state = 'trashed' AND deleted_at <= ?
      `).all(cutoff) as Array<{ id: string }>;
      if (!ids.length) return 0;

      const removeFromSearch = this.db.prepare("DELETE FROM entry_search WHERE entry_id = ?");
      for (const { id } of ids) removeFromSearch.run(id);
      return this.db.prepare(`
        DELETE FROM entries WHERE state = 'trashed' AND deleted_at <= ?
      `).run(cutoff).changes;
    });
    return purge();
  }

  searchPublished(query: string): Entry[] {
    const text = query.trim();
    if (!text) return [];
    const useFts = Array.from(text).length >= 3;
    const rows = this.db.prepare(`
      SELECT entries.id, entries.title, entries.markdown, entries.state,
        entries.published_at, entries.created_at, entries.updated_at, entries.deleted_at, entries.edited_at
      FROM entries
      INNER JOIN entry_search ON entry_search.entry_id = entries.id
      WHERE entries.state = 'published' AND (
        ${useFts
          ? "entry_search MATCH ?"
          : "entry_search.title LIKE ? OR entry_search.body LIKE ? OR entry_search.tags LIKE ? OR entry_search.song_title LIKE ? OR entry_search.song_artist LIKE ? OR entry_search.song_album LIKE ?"}
      )
      ORDER BY entries.published_at DESC
    `).all(...(useFts
      ? [this.ftsPhrase(text)]
      : Array(6).fill(`%${text}%`))) as EntryRow[];
    return rows.map((row) => this.toEntry(row));
  }

  private getById(id: string): Entry | null {
    const row = this.db.prepare(`
      SELECT id, title, markdown, state, published_at, created_at, updated_at, deleted_at, edited_at
      FROM entries WHERE id = ?
    `).get(id) as EntryRow | undefined;
    return row ? this.toEntry(row) : null;
  }

  private getPublishedById(id: string): Entry | null {
    const row = this.db.prepare(`
      SELECT id, title, markdown, state, published_at, created_at, updated_at, deleted_at, edited_at
      FROM entries WHERE id = ? AND state = 'published'
    `).get(id) as EntryRow | undefined;
    return row ? this.toEntry(row) : null;
  }

  private replaceTags(entryId: string, tags: string[]): void {
    this.db.prepare("DELETE FROM entry_tags WHERE entry_id = ?").run(entryId);
    for (const name of new Set(tags)) {
      this.db.prepare("INSERT INTO tags (id, name) VALUES (?, ?) ON CONFLICT(name) DO NOTHING")
        .run(randomUUID(), name);
      const tag = this.db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as { id: string };
      this.db.prepare("INSERT INTO entry_tags (entry_id, tag_id) VALUES (?, ?)").run(entryId, tag.id);
    }
  }

  private reindex(entryId: string): void {
    const entry = this.getById(entryId);
    if (!entry) return;

    this.db.prepare("DELETE FROM entry_search WHERE entry_id = ?").run(entryId);
    const music = this.db.prepare(`
      SELECT title, artist, album, user_overrides_json FROM entry_music WHERE entry_id = ?
    `).get(entryId) as {
      title: string | null;
      artist: string | null;
      album: string | null;
      user_overrides_json: string;
    } | undefined;
    const overrides = music ? parseMusicOverrides(music.user_overrides_json) : {};
    this.db.prepare(`
      INSERT INTO entry_search (entry_id, title, body, tags, song_title, song_artist, song_album)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.title,
      entry.markdown,
      entry.tags.join(" "),
      musicSearchValue(overrides, "title", music?.title),
      musicSearchValue(overrides, "artist", music?.artist),
      musicSearchValue(overrides, "album", music?.album),
    );
  }

  private ftsPhrase(query: string): string {
    return `"${query.replaceAll('"', '""')}"`;
  }

  private sameTags(left: string[], right: string[]): boolean {
    const normalized = (tags: string[]) => [...new Set(tags)].sort();
    const normalizedLeft = normalized(left);
    const normalizedRight = normalized(right);
    return normalizedLeft.length === normalizedRight.length
      && normalizedLeft.every((tag, index) => tag === normalizedRight[index]);
  }

  private toEntry(row: EntryRow): Entry {
    const tags = this.db.prepare(`
      SELECT tags.name FROM tags
      INNER JOIN entry_tags ON entry_tags.tag_id = tags.id
      WHERE entry_tags.entry_id = ?
      ORDER BY tags.name
    `).all(row.id) as Array<{ name: string }>;
    return {
      id: row.id,
      title: row.title,
      markdown: row.markdown,
      state: row.state,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      edited: row.edited_at !== null,
      tags: tags.map((tag) => tag.name),
      music: this.musicForEntry(row.id),
    };
  }

  private musicForEntry(entryId: string): EntryMusic | null {
    const row = this.db.prepare(`
      SELECT
        entry_music.media_id, entry_music.title, entry_music.artist, entry_music.album,
        entry_music.year, entry_music.cover_media_id, entry_music.recognition_status,
        entry_music.user_overrides_json, entry_music.original_filename,
        media.original_hash, media.original_mime, media.original_extension
      FROM entry_music
      INNER JOIN media
        ON media.id = entry_music.media_id
        AND media.entry_id = entry_music.entry_id
      WHERE entry_music.entry_id = ?
    `).get(entryId) as {
      media_id: string;
      title: string | null;
      artist: string | null;
      album: string | null;
      year: number | null;
      cover_media_id: string | null;
      recognition_status: EntryMusic["recognitionStatus"];
      user_overrides_json: string;
      original_filename: string;
      original_hash: string;
      original_mime: string;
      original_extension: string;
    } | undefined;
    if (!row) return null;

    const overrides = parseMusicOverrides(row.user_overrides_json);
    const coverMediaId = overridden(overrides, "coverMediaId", row.cover_media_id);
    return {
      mediaId: row.media_id,
      title: overridden(overrides, "title", row.title),
      artist: overridden(overrides, "artist", row.artist),
      album: overridden(overrides, "album", row.album),
      year: overridden(overrides, "year", row.year),
      coverMediaId,
      coverMime: coverMediaId ? this.coverMime(coverMediaId, entryId) : null,
      recognitionStatus: row.recognition_status,
      originalFilename: row.original_filename,
      streamUrl: `/api/v1/music/${encodeURIComponent(row.media_id)}/stream`,
      coverUrl: coverMediaId
        ? `/api/v1/media/${encodeURIComponent(coverMediaId)}/display`
        : null,
      available: this.mediaStore
        ? isStoredMp3Available(
            this.mediaStore,
            row.original_hash,
            row.original_mime,
            row.original_extension,
          )
        : false,
    };
  }

  private coverMime(mediaId: string, entryId: string): string | null {
    const cover = this.db.prepare(`
      SELECT original_mime FROM media
      WHERE id = ? AND entry_id = ? AND original_mime LIKE 'image/%'
    `).get(mediaId, entryId) as { original_mime: string } | undefined;
    return cover?.original_mime ?? null;
  }
}

function parseMusicOverrides(value: string): {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | null;
  coverMediaId?: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const overrides: {
      title?: string | null;
      artist?: string | null;
      album?: string | null;
      year?: number | null;
      coverMediaId?: string | null;
    } = {};
    for (const key of ["title", "artist", "album"] as const) {
      if (record[key] === null || typeof record[key] === "string") overrides[key] = record[key];
    }
    if (record.year === null || Number.isInteger(record.year)) {
      overrides.year = record.year as number | null;
    }
    if (record.coverMediaId === null || typeof record.coverMediaId === "string") {
      overrides.coverMediaId = record.coverMediaId;
    }
    return overrides;
  } catch {
    return {};
  }
}

function overridden<TValue>(
  overrides: object,
  key: string,
  fallback: TValue,
): TValue {
  return Object.prototype.hasOwnProperty.call(overrides, key)
    ? (overrides as Record<string, TValue>)[key]!
    : fallback;
}

function isStoredMp3Available(
  store: MediaStore,
  hash: string,
  mime: string,
  extension: string,
): boolean {
  if (
    !/^[a-f0-9]{64}$/.test(hash)
    || mime !== "audio/mpeg"
    || extension !== "mp3"
  ) return false;

  let descriptor: number | undefined;
  try {
    const objectPath = store.pathFor(hash, extension);
    if (!statSync(objectPath).isFile()) return false;
    descriptor = openSync(objectPath, "r");
    const header = Buffer.alloc(3);
    if (readSync(descriptor, header, 0, header.length, 0) < 3) return false;
    return header.toString("ascii") === "ID3"
      || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function musicSearchValue(
  overrides: { title?: string | null; artist?: string | null; album?: string | null },
  key: "title" | "artist" | "album",
  base: string | null | undefined,
): string {
  return Object.prototype.hasOwnProperty.call(overrides, key)
    ? overrides[key] ?? ""
    : base ?? "";
}
