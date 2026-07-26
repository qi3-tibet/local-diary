import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fromMarkdown } from "mdast-util-from-markdown";
import { stringify as stringifyYaml } from "yaml";
import yazl from "yazl";
import type { DiaryDatabase } from "../db/client.js";
import type { MediaStore } from "../media/store.js";

const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const EXTENSION = /^[a-z0-9]{1,16}$/u;
const PUBLISHED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/u;
const MAX_RANGE_DAYS = 366;
const MAX_ENTRIES = 10_000;
const MAX_MEDIA = 100_000;

export type MarkdownExportSelection =
  | { entryId: string; from?: never; to?: never }
  | { entryId?: never; from: string; to: string };

export type MarkdownExportContext = {
  database: DiaryDatabase;
  mediaStore: MediaStore;
};

type EntryRow = {
  id: string;
  title: string;
  markdown: string;
  published_at: string;
  updated_at: string;
};

type MediaRow = {
  id: string;
  entry_id: string;
  original_hash: string;
  original_mime: string;
  original_extension: string;
};

type MusicRow = {
  media_id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  cover_media_id: string | null;
  recognition_status: string;
  recognition_source: string | null;
  selected_candidate_id: string | null;
  user_overrides_json: string;
  original_filename: string;
};

type MusicOverrides = {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | null;
  coverMediaId?: string | null;
};

type ExportObject = {
  archivePath: string;
  diskPath: string;
  hash: string;
};

type Replacement = {
  start: number;
  end: number;
  mediaId: string;
};

type PositionedNode = {
  type?: string;
  url?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  children?: PositionedNode[];
};

export function validateMarkdownExportSelection(value: unknown): MarkdownExportSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("EXPORT_SELECTION_INVALID");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["entryId", "from", "to"].includes(key))) {
    throw new Error("EXPORT_SELECTION_INVALID");
  }
  const hasEntry = typeof record.entryId === "string";
  const hasFrom = typeof record.from === "string";
  const hasTo = typeof record.to === "string";
  if (hasEntry) {
    if (hasFrom || hasTo || !UUID.test(record.entryId as string)) throw new Error("EXPORT_SELECTION_INVALID");
    return { entryId: record.entryId as string };
  }
  if (!hasFrom || !hasTo) throw new Error("EXPORT_SELECTION_INVALID");
  const from = record.from as string;
  const to = record.to as string;
  if (!validDay(from) || !validDay(to) || from > to || rangeDays(from, to) > MAX_RANGE_DAYS) {
    throw new Error("EXPORT_SELECTION_INVALID");
  }
  return { from, to };
}

export async function exportMarkdownArchive(
  selectionInput: MarkdownExportSelection,
  context: MarkdownExportContext,
  output: string,
): Promise<void> {
  const selection = validateMarkdownExportSelection(selectionInput);
  const entries = selectEntries(context.database, selection);
  if (entries.length === 0) {
    throw new Error("entryId" in selection ? "EXPORT_ENTRY_NOT_FOUND" : "EXPORT_RANGE_EMPTY");
  }
  if (entries.length > MAX_ENTRIES) throw new Error("EXPORT_ENTRY_LIMIT");

  const objects = new Map<string, ExportObject>();
  const usedNames = new Map<string, number>();
  const documents = entries.map((entry) => buildDocument(entry, context, objects, usedNames));
  if (objects.size > MAX_MEDIA) throw new Error("EXPORT_MEDIA_LIMIT");
  await verifyObjects([...objects.values()]);

  const target = resolve(output);
  if (await lstat(target).catch(missing)) throw new Error("EXPORT_OUTPUT_EXISTS");
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const zip = new yazl.ZipFile();
  try {
    for (const document of documents) {
      zip.addBuffer(Buffer.from(document.markdown), document.path, {
        compress: false,
        mtime: ZIP_EPOCH,
        mode: 0o100600,
      });
    }
    for (const object of [...objects.values()].sort((left, right) => left.archivePath.localeCompare(right.archivePath, "en"))) {
      zip.addFile(object.diskPath, object.archivePath, {
        compress: false,
        mtime: ZIP_EPOCH,
        mode: 0o100600,
      });
    }
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(temporary, { flags: "wx" }));
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("EXPORT_OUTPUT_EXISTS");
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function selectEntries(database: DiaryDatabase, selection: MarkdownExportSelection): EntryRow[] {
  if ("entryId" in selection) {
    return database.prepare(`
      SELECT id, title, markdown, published_at, updated_at
      FROM entries
      WHERE id = ? AND state = 'published'
    `).all(selection.entryId) as EntryRow[];
  }
  const upperBound = nextDay(selection.to);
  return database.prepare(`
    SELECT id, title, markdown, published_at, updated_at
    FROM entries
    WHERE state = 'published'
      AND published_at >= ?
      AND published_at < ?
    ORDER BY published_at ASC, id ASC
    LIMIT ?
  `).all(
    `${selection.from}T00:00:00+08:00`,
    `${upperBound}T00:00:00+08:00`,
    MAX_ENTRIES + 1,
  ) as EntryRow[];
}

function buildDocument(
  entry: EntryRow,
  context: MarkdownExportContext,
  objects: Map<string, ExportObject>,
  usedNames: Map<string, number>,
): { path: string; markdown: string } {
  if (!PUBLISHED_AT.test(entry.published_at) || !validDay(entry.published_at.slice(0, 10))) {
    throw new Error("EXPORT_ENTRY_INVALID");
  }
  const day = entry.published_at.slice(0, 10);
  const time = entry.published_at.slice(11, 16).replace(":", "");
  const baseName = `${time}-${safeSlug(entry.title)}`;
  const collisionKey = `${day}/${baseName}`.toLocaleLowerCase("en");
  const collision = (usedNames.get(collisionKey) ?? 0) + 1;
  usedNames.set(collisionKey, collision);
  const path = `${day}/${baseName}${collision === 1 ? "" : `-${collision}`}.md`;

  const { replacements, mediaIds } = parseImageReferences(entry.markdown);
  const mediaMap = new Map<string, string>();
  for (const mediaId of mediaIds) {
    const media = context.database.prepare(`
      SELECT id, entry_id, original_hash, original_mime, original_extension
      FROM media
      WHERE id = ? AND entry_id = ? AND original_mime LIKE 'image/%'
    `).get(mediaId, entry.id) as MediaRow | undefined;
    if (!media) throw new Error("EXPORT_MEDIA_MISSING");
    const archivePath = addMediaObject(media, context.mediaStore, objects);
    mediaMap.set(mediaId, `../${archivePath}`);
  }

  const music = context.database.prepare(`
    SELECT media_id, title, artist, album, year, cover_media_id,
      recognition_status, recognition_source, selected_candidate_id,
      user_overrides_json, original_filename
    FROM entry_music
    WHERE entry_id = ?
  `).get(entry.id) as MusicRow | undefined;
  const tags = context.database.prepare(`
    SELECT tags.name
    FROM tags
    INNER JOIN entry_tags ON entry_tags.tag_id = tags.id
    WHERE entry_tags.entry_id = ?
    ORDER BY tags.name
  `).all(entry.id) as Array<{ name: string }>;

  let musicMetadata: Record<string, unknown> = {};
  if (music) {
    const audio = requireMedia(context.database, entry.id, music.media_id, "audio/mpeg");
    const musicFile = `../${addMediaObject(audio, context.mediaStore, objects)}`;
    const overrides = parseOverrides(music.user_overrides_json);
    const coverMediaId = effective(overrides, "coverMediaId", music.cover_media_id);
    let musicCover: string | null = null;
    if (coverMediaId) {
      const cover = requireMedia(context.database, entry.id, coverMediaId, "image/");
      musicCover = `../${addMediaObject(cover, context.mediaStore, objects)}`;
    }
    musicMetadata = {
      song_title: effective(overrides, "title", music.title),
      song_artist: effective(overrides, "artist", music.artist),
      song_album: effective(overrides, "album", music.album),
      song_year: effective(overrides, "year", music.year),
      music_file: musicFile,
      music_cover: musicCover,
      music_recognition_status: music.recognition_status,
      music_recognition_source: music.recognition_source,
      music_selected_candidate_id: music.selected_candidate_id,
      music_original_filename: music.original_filename,
    };
  }

  const frontMatter = stringifyYaml({
    id: entry.id,
    title: entry.title,
    published_at: entry.published_at,
    updated_at: entry.updated_at,
    tags: tags.map((tag) => tag.name),
    ...musicMetadata,
  }, {
    defaultStringType: "QUOTE_DOUBLE",
    lineWidth: 0,
  });
  const body = applyImageReplacements(entry.markdown, replacements, mediaMap);
  return { path, markdown: `---\n${frontMatter}---\n\n${body}` };
}

function parseImageReferences(markdown: string): { replacements: Replacement[]; mediaIds: string[] } {
  const tree = fromMarkdown(markdown) as PositionedNode;
  const replacements: Replacement[] = [];
  const mediaIds: string[] = [];
  walk(tree, (node) => {
    if (node.type !== "image" || typeof node.url !== "string" || !node.url.startsWith("media:")) return;
    const mediaId = node.url.slice("media:".length);
    const nodeStart = node.position?.start?.offset;
    const nodeEnd = node.position?.end?.offset;
    if (!mediaId || nodeStart === undefined || nodeEnd === undefined) throw new Error("EXPORT_MARKDOWN_INVALID");
    const raw = markdown.slice(nodeStart, nodeEnd);
    const labelEnd = raw.indexOf("](");
    const relativeStart = labelEnd < 0 ? -1 : raw.indexOf(node.url, labelEnd + 2);
    if (relativeStart < 0) throw new Error("EXPORT_MARKDOWN_INVALID");
    replacements.push({
      start: nodeStart + relativeStart,
      end: nodeStart + relativeStart + node.url.length,
      mediaId,
    });
    if (!mediaIds.includes(mediaId)) mediaIds.push(mediaId);
  });
  return { replacements, mediaIds };
}

function walk(node: PositionedNode, visit: (node: PositionedNode) => void): void {
  visit(node);
  node.children?.forEach((child) => walk(child, visit));
}

function applyImageReplacements(
  markdown: string,
  replacements: Replacement[],
  mediaMap: Map<string, string>,
): string {
  let result = markdown;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    const destination = mediaMap.get(replacement.mediaId);
    if (!destination) throw new Error("EXPORT_MEDIA_MISSING");
    result = `${result.slice(0, replacement.start)}${destination}${result.slice(replacement.end)}`;
  }
  return result;
}

function requireMedia(
  database: DiaryDatabase,
  entryId: string,
  mediaId: string,
  mimePrefix: string,
): MediaRow {
  const media = database.prepare(`
    SELECT id, entry_id, original_hash, original_mime, original_extension
    FROM media
    WHERE id = ? AND entry_id = ?
  `).get(mediaId, entryId) as MediaRow | undefined;
  if (!media || !media.original_mime.startsWith(mimePrefix)) throw new Error("EXPORT_MEDIA_MISSING");
  return media;
}

function addMediaObject(
  media: MediaRow,
  store: MediaStore,
  objects: Map<string, ExportObject>,
): string {
  if (!HASH.test(media.original_hash) || !EXTENSION.test(media.original_extension)) {
    throw new Error("EXPORT_MEDIA_INVALID");
  }
  const archivePath = `media/${media.original_hash}.${media.original_extension}`;
  const diskPath = store.pathFor(media.original_hash, media.original_extension);
  const existing = objects.get(archivePath);
  if (existing && existing.diskPath !== diskPath) throw new Error("EXPORT_MEDIA_COLLISION");
  objects.set(archivePath, { archivePath, diskPath, hash: media.original_hash });
  return archivePath;
}

async function verifyObjects(objects: ExportObject[]): Promise<void> {
  for (const object of objects.sort((left, right) => left.archivePath.localeCompare(right.archivePath, "en"))) {
    let details;
    try {
      details = await stat(object.diskPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("EXPORT_MEDIA_MISSING");
      throw error;
    }
    if (!details.isFile()) throw new Error("EXPORT_MEDIA_MISSING");
    const hash = createHash("sha256");
    await pipeline(createReadStream(object.diskPath), async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    });
    if (hash.digest("hex") !== object.hash) throw new Error("EXPORT_MEDIA_CORRUPT");
  }
}

function parseOverrides(value: string): MusicOverrides {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const input = parsed as Record<string, unknown>;
    const overrides: MusicOverrides = {};
    for (const key of ["title", "artist", "album"] as const) {
      if (input[key] === null || typeof input[key] === "string") overrides[key] = input[key];
    }
    if (input.year === null || Number.isInteger(input.year)) overrides.year = input.year as number | null;
    if (input.coverMediaId === null || typeof input.coverMediaId === "string") {
      overrides.coverMediaId = input.coverMediaId;
    }
    return overrides;
  } catch {
    return {};
  }
}

function effective<TKey extends keyof MusicOverrides>(
  overrides: MusicOverrides,
  key: TKey,
  fallback: MusicOverrides[TKey],
): MusicOverrides[TKey] {
  return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback;
}

function safeSlug(title: string): string {
  let slug = title.normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, " ")
    .trim()
    .replace(/[\s.]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLocaleLowerCase("en");
  slug = [...slug].slice(0, 80).join("").replace(/[ .-]+$/gu, "");
  if (!slug) return "entry";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(slug)) slug = `_${slug}`;
  return slug;
}

function validDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function rangeDays(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1;
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

function missing(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}
