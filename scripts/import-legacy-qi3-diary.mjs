import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createDiaryDatabase, validateCurrentDiarySchema } from "../apps/server/dist/db/client.js";
import { EntryRepository } from "../apps/server/dist/entries/repository.js";
import { MediaStore } from "../apps/server/dist/media/store.js";
import { MusicService } from "../apps/server/dist/music/service.js";
import { SnapshotService } from "../apps/server/dist/backup/snapshot.js";
import { exportArchive, validateArchive } from "../apps/server/dist/backup/archive.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const BEIJING_MINUTE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u;

const [sourcePath, stageDataRoot, stageBackupRoot, archivePath] = process.argv.slice(2);
if (!sourcePath || !stageDataRoot || !stageBackupRoot || !archivePath) {
  throw new Error(
    "Usage: node scripts/import-legacy-qi3-diary.mjs <source.json> <stage-data> <stage-backups> <archive.zip>",
  );
}

const sourceBytes = await readFile(path.resolve(sourcePath));
const legacy = JSON.parse(sourceBytes.toString("utf8"));
assertLegacyBackup(legacy);

const database = createDiaryDatabase(path.resolve(stageDataRoot));
const mediaStore = new MediaStore(path.join(path.resolve(stageDataRoot), "media"));
const musicService = new MusicService(database, mediaStore);
const repository = new EntryRepository(database, mediaStore);
const musicById = new Map(legacy.music.map((item) => [String(item.id), item]));
const imported = [];

try {
  for (const record of legacy.records) {
    const entryId = randomUUID();
    const publishedAt = normalizePublishedAt(record.date);
    const createdAt = normalizeIso(record.createdAt);
    const title = indexTitle(record.content);

    database.transaction(() => {
      database.prepare(`
        INSERT INTO entries (
          id, title, markdown, state, published_at, created_at, updated_at, deleted_at, edited_at
        ) VALUES (?, ?, ?, 'published', ?, ?, ?, NULL, NULL)
      `).run(entryId, title, record.content, publishedAt, createdAt, createdAt);
      database.prepare(`
        INSERT INTO entry_search (
          entry_id, title, body, tags, song_title, song_artist, song_album
        ) VALUES (?, ?, ?, '', '', '', '')
      `).run(entryId, title, record.content);
    })();

    if (record.music) {
      const sourceMusic = musicById.get(String(record.music.id));
      if (!sourceMusic) throw new Error("LEGACY_MUSIC_REFERENCE_MISSING");
      const audio = decodeDataUrl(sourceMusic.audioBlob, "audio/mpeg");
      const expectedCover = decodeImageDataUrl(sourceMusic.coverBlob);
      const attached = await musicService.attach(entryId, audio.bytes, record.music.fileName);
      if (!attached.coverPath || !attached.coverMediaId) {
        throw new Error("LEGACY_EMBEDDED_COVER_MISSING");
      }
      const storedCover = await readFile(attached.coverPath);
      if (hash(storedCover) !== hash(expectedCover.bytes)) {
        throw new Error("LEGACY_COVER_MISMATCH");
      }
      const overrides = {
        title: record.music.title,
        artist: record.music.artist,
        album: record.music.album,
      };
      database.transaction(() => {
        database.prepare(`
          UPDATE entry_music
          SET title = ?, artist = ?, album = ?, recognition_status = 'manual',
              user_overrides_json = ?
          WHERE entry_id = ?
        `).run(
          record.music.title,
          record.music.artist,
          record.music.album,
          JSON.stringify(overrides),
          entryId,
        );
        database.prepare(`
          UPDATE entry_search
          SET song_title = ?, song_artist = ?, song_album = ?
          WHERE entry_id = ?
        `).run(record.music.title, record.music.artist, record.music.album, entryId);
      })();
    }

    imported.push({
      entryId,
      sourceId: String(record.id),
      markdown: record.content,
      publishedAt,
      hasMusic: Boolean(record.music),
    });
  }

  validateImportedDiary(database, repository, imported);

  const snapshots = new SnapshotService({
    dataRoot: path.resolve(stageDataRoot),
    backupRoot: path.resolve(stageBackupRoot),
    database,
  });
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const snapshot = await snapshots.createSafetySnapshot(day);
  await exportArchive(snapshot.id, snapshots, path.resolve(archivePath));
  const manifest = await validateArchive(path.resolve(archivePath));

  process.stdout.write(`${JSON.stringify({
    sourceSha256: hash(sourceBytes),
    records: imported.length,
    dateOnlyRecords: imported.filter((item) => DATE_ONLY.test(item.publishedAt)).length,
    minuteRecords: imported.filter((item) => !DATE_ONLY.test(item.publishedAt)).length,
    music: imported.filter((item) => item.hasMusic).length,
    mediaObjects: manifest.mediaObjects.length,
    archive: path.resolve(archivePath),
  })}\n`);
} finally {
  database.close();
}

function assertLegacyBackup(value) {
  if (
    !value
    || value.app !== "qi3-diary"
    || value.version !== 1
    || !Array.isArray(value.records)
    || !Array.isArray(value.music)
  ) {
    throw new Error("LEGACY_BACKUP_FORMAT_INVALID");
  }
  if (value.records.length !== 34 || value.music.length !== 8) {
    throw new Error("LEGACY_BACKUP_COUNTS_UNEXPECTED");
  }
  const recordIds = new Set();
  for (const record of value.records) {
    if (
      recordIds.has(String(record.id))
      || typeof record.content !== "string"
      || !record.content.trim()
      || (!DATE_ONLY.test(record.date) && !BEIJING_MINUTE.test(record.date))
      || !Number.isFinite(Date.parse(record.createdAt))
    ) {
      throw new Error("LEGACY_RECORD_INVALID");
    }
    recordIds.add(String(record.id));
  }
  if (value.records.filter((record) => DATE_ONLY.test(record.date)).length !== 1) {
    throw new Error("LEGACY_DATE_PRECISION_UNEXPECTED");
  }
  const musicIds = new Set(value.music.map((item) => String(item.id)));
  if (
    musicIds.size !== value.music.length
    || value.records.some((record) => record.music && !musicIds.has(String(record.music.id)))
  ) {
    throw new Error("LEGACY_MUSIC_REFERENCE_INVALID");
  }
}

function normalizePublishedAt(value) {
  if (DATE_ONLY.test(value)) {
    assertCalendarDay(value);
    return value;
  }
  if (!BEIJING_MINUTE.test(value)) throw new Error("LEGACY_PUBLISHED_AT_INVALID");
  const [day, time] = value.split(" ");
  assertCalendarDay(day);
  const timestamp = `${day}T${time}:00+08:00`;
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("LEGACY_PUBLISHED_AT_INVALID");
  return timestamp;
}

function assertCalendarDay(day) {
  const [year, month, date] = day.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, date));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() + 1 !== month
    || candidate.getUTCDate() !== date
  ) {
    throw new Error("LEGACY_DAY_INVALID");
  }
}

function normalizeIso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("LEGACY_CREATED_AT_INVALID");
  return date.toISOString();
}

function indexTitle(markdown) {
  const firstLine = markdown.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  const normalized = firstLine.replace(/\s+/gu, " ");
  const title = [...normalized].slice(0, 30).join("");
  return title || "UNTITLED";
}

function decodeDataUrl(value, expectedMime) {
  if (typeof value !== "string") throw new Error("LEGACY_MEDIA_INVALID");
  const match = /^data:([^;,]+);base64,([\s\S]+)$/u.exec(value);
  if (!match || match[1].toLowerCase() !== expectedMime) {
    throw new Error("LEGACY_MEDIA_MIME_INVALID");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length) throw new Error("LEGACY_MEDIA_EMPTY");
  return { bytes, declaredMime: match[1].toLowerCase() };
}

function decodeImageDataUrl(value) {
  if (typeof value !== "string") throw new Error("LEGACY_COVER_INVALID");
  const match = /^data:(image\/[^;,]+);base64,([\s\S]+)$/u.exec(value);
  if (!match) throw new Error("LEGACY_COVER_INVALID");
  const bytes = Buffer.from(match[2], "base64");
  const actualMime = bytes[0] === 0xff && bytes[1] === 0xd8
    ? "image/jpeg"
    : bytes[0] === 0x89 && bytes.subarray(1, 4).toString("ascii") === "PNG"
    ? "image/png"
    : null;
  if (!actualMime) throw new Error("LEGACY_COVER_FORMAT_INVALID");
  return { bytes, declaredMime: match[1].toLowerCase(), actualMime };
}

function validateImportedDiary(database, repository, importedEntries) {
  validateCurrentDiarySchema(database);
  const integrity = database.pragma("integrity_check", { simple: true });
  const foreignKeys = database.pragma("foreign_key_check");
  if (integrity !== "ok" || foreignKeys.length) throw new Error("MIGRATED_DATABASE_INVALID");
  if (
    repository.countByState("published") !== 34
    || repository.countByState("draft") !== 0
    || repository.countByState("trashed") !== 0
  ) {
    throw new Error("MIGRATED_ENTRY_COUNTS_INVALID");
  }
  const rows = database.prepare(`
    SELECT id, markdown, published_at FROM entries ORDER BY published_at, id
  `).all();
  if (
    rows.length !== importedEntries.length
    || importedEntries.some((expected) => {
      const actual = rows.find((row) => row.id === expected.entryId);
      return !actual
        || actual.markdown !== expected.markdown
        || actual.published_at !== expected.publishedAt;
    })
  ) {
    throw new Error("MIGRATED_ENTRY_CONTENT_MISMATCH");
  }
  const musicCount = database.prepare("SELECT COUNT(*) AS count FROM entry_music").get().count;
  const mediaCount = database.prepare("SELECT COUNT(*) AS count FROM media").get().count;
  const searchCount = database.prepare("SELECT COUNT(*) AS count FROM entry_search").get().count;
  if (musicCount !== 8 || mediaCount !== 16 || searchCount !== 34) {
    throw new Error("MIGRATED_RELATED_COUNTS_INVALID");
  }
  const page = repository.selectDayWindow({ direction: "older", limitEntries: 120 });
  const entries = page.days.flatMap((item) => item.entries);
  if (
    entries.length !== 34
    || entries.filter((entry) => entry.music?.available).length !== 8
  ) {
    throw new Error("MIGRATED_ENTRY_READBACK_INVALID");
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
