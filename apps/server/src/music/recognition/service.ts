import {
  recognitionCandidateSchema,
  type MusicMetadataOverride,
} from "@diary/contracts";
import type { DiaryDatabase } from "../../db/client.js";
import { MediaStore } from "../../media/store.js";
import { applyOverrides, recognizeMusic } from "./pipeline.js";
import type {
  FingerprintLookup,
  MusicFields,
  MusicOverrides,
  RecognitionCandidate,
  TextLookup,
} from "./types.js";

type MusicRow = {
  media_id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  cover_media_id: string | null;
  recognition_status: MusicRecognitionStatus;
  user_overrides_json: string;
  original_filename: string;
  recognition_candidates_json: string;
  recognition_source: "text" | "fingerprint" | "manual" | null;
  selected_candidate_id: string | null;
  original_hash: string;
  original_extension: string;
};

export type MusicRecognitionStatus =
  | "embedded"
  | "manual_required"
  | "candidates"
  | "recognized"
  | "manual";

export class MusicRecognitionNotFoundError extends Error {
  constructor() { super("MUSIC_NOT_FOUND"); }
}

export class MusicRecognitionValidationError extends Error {
  constructor(message: string) { super(message); }
}

export type MusicRecognitionResponse = MusicFields & {
  mediaId: string;
  recognitionStatus: MusicRecognitionStatus;
  candidates: RecognitionCandidate[];
  selectedCandidateId: string | null;
};

export class MusicRecognitionService {
  constructor(
    private readonly database: DiaryDatabase,
    private readonly store: MediaStore,
    private readonly textLookup: TextLookup,
    private readonly fingerprintLookup: FingerprintLookup,
  ) {}

  async request(entryId: string): Promise<MusicRecognitionResponse> {
    const row = this.getRow(entryId);
    const base = fieldsFromRow(row);
    const effective = applyOverrides(base, parseOverrides(row.user_overrides_json));
    const result = await recognizeMusic(
      effective,
      row.original_filename,
      this.textLookup,
      this.fingerprintLookup,
      this.store.pathFor(row.original_hash, row.original_extension),
    );
    const status: MusicRecognitionStatus = result.manualRequired
      ? "manual_required"
      : "candidates";
    this.database.prepare(`
      UPDATE entry_music
      SET recognition_status = ?, recognition_candidates_json = ?,
        recognition_source = ?, selected_candidate_id = NULL
      WHERE entry_id = ?
    `).run(status, JSON.stringify(result.candidates), result.source, entryId);
    return this.response(this.getRow(entryId));
  }

  listCandidates(entryId: string): RecognitionCandidate[] {
    return parseCandidates(this.getRow(entryId).recognition_candidates_json);
  }

  selectCandidate(entryId: string, candidateId: string): MusicRecognitionResponse {
    const row = this.getRow(entryId);
    const candidate = parseCandidates(row.recognition_candidates_json)
      .find((item) => item.id === candidateId);
    if (!candidate) throw new MusicRecognitionValidationError("RECOGNITION_CANDIDATE_NOT_FOUND");
    const selected = supplementCandidate(candidate, fieldsFromRow(row));
    const overrides = parseOverrides(row.user_overrides_json);
    const status: MusicRecognitionStatus = Object.keys(overrides).length > 0
      ? "manual"
      : "recognized";
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE entry_music SET
          title = ?, artist = ?, album = ?, year = ?, cover_media_id = ?,
          recognition_status = ?, selected_candidate_id = ?
        WHERE entry_id = ?
      `).run(
        selected.title,
        selected.artist,
        selected.album,
        selected.year,
        selected.coverMediaId,
        status,
        candidate.id,
        entryId,
      );
      this.updateSearch(entryId, applyOverrides(selected, overrides));
    })();
    return this.response(this.getRow(entryId));
  }

  patchOverrides(
    entryId: string,
    patch: MusicMetadataOverride,
  ): MusicRecognitionResponse {
    const row = this.getRow(entryId);
    const normalized = normalizeOverrides(patch);
    this.validateCover(entryId, normalized);
    const overrides = { ...parseOverrides(row.user_overrides_json), ...normalized };
    const effective = applyOverrides(fieldsFromRow(row), overrides);
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE entry_music
        SET user_overrides_json = ?, recognition_status = 'manual'
        WHERE entry_id = ?
      `).run(JSON.stringify(overrides), entryId);
      this.updateSearch(entryId, effective);
    })();
    return this.response(this.getRow(entryId));
  }

  private getRow(entryId: string): MusicRow {
    const row = this.database.prepare(`
      SELECT
        entry_music.media_id, entry_music.title, entry_music.artist, entry_music.album,
        entry_music.year, entry_music.cover_media_id, entry_music.recognition_status,
        entry_music.user_overrides_json, entry_music.original_filename,
        entry_music.recognition_candidates_json, entry_music.recognition_source,
        entry_music.selected_candidate_id, media.original_hash, media.original_extension
      FROM entry_music
      INNER JOIN entries ON entries.id = entry_music.entry_id
      INNER JOIN media ON media.id = entry_music.media_id
      WHERE entry_music.entry_id = ? AND entries.state != 'trashed'
    `).get(entryId) as MusicRow | undefined;
    if (!row) throw new MusicRecognitionNotFoundError();
    return row;
  }

  private response(row: MusicRow): MusicRecognitionResponse {
    return {
      mediaId: row.media_id,
      ...applyOverrides(fieldsFromRow(row), parseOverrides(row.user_overrides_json)),
      recognitionStatus: row.recognition_status,
      candidates: parseCandidates(row.recognition_candidates_json),
      selectedCandidateId: row.selected_candidate_id,
    };
  }

  private validateCover(entryId: string, overrides: MusicOverrides): void {
    if (!Object.prototype.hasOwnProperty.call(overrides, "coverMediaId")) return;
    if (overrides.coverMediaId === null) return;
    const cover = this.database.prepare(`
      SELECT 1 FROM media
      WHERE id = ? AND entry_id = ? AND original_mime LIKE 'image/%'
    `).get(overrides.coverMediaId, entryId);
    if (!cover) throw new MusicRecognitionValidationError("INVALID_COVER_MEDIA");
  }

  private updateSearch(entryId: string, metadata: MusicFields): void {
    this.database.prepare(`
      UPDATE entry_search
      SET song_title = ?, song_artist = ?, song_album = ?
      WHERE entry_id = ?
    `).run(metadata.title ?? "", metadata.artist ?? "", metadata.album ?? "", entryId);
  }
}

function fieldsFromRow(row: MusicRow): MusicFields {
  return {
    title: row.title,
    artist: row.artist,
    album: row.album,
    year: row.year,
    coverMediaId: row.cover_media_id,
  };
}

function supplementCandidate(
  candidate: RecognitionCandidate,
  embedded: MusicFields,
): MusicFields {
  return {
    title: candidate.title ?? embedded.title,
    artist: candidate.artist ?? embedded.artist,
    album: candidate.album ?? embedded.album,
    year: candidate.year ?? embedded.year,
    coverMediaId: candidate.coverMediaId ?? embedded.coverMediaId,
  };
}

function parseOverrides(value: string): MusicOverrides {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};
    const overrides: MusicOverrides = {};
    for (const key of ["title", "artist", "album", "year", "coverMediaId"] as const) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        const candidate = parsed[key];
        if (
          candidate === null
          || (key === "year" ? Number.isInteger(candidate) : typeof candidate === "string")
        ) {
          Object.assign(overrides, { [key]: candidate });
        }
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

function parseCandidates(value: string): RecognitionCandidate[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      const result = recognitionCandidateSchema.safeParse(candidate);
      return result.success ? [result.data] : [];
    }).slice(0, 5);
  } catch {
    return [];
  }
}

function normalizeOverrides(patch: MusicMetadataOverride): MusicOverrides {
  const normalized: MusicOverrides = {};
  for (const key of ["title", "artist", "album"] as const) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      const value = patch[key];
      normalized[key] = typeof value === "string" ? value.trim() || null : null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "year")) normalized.year = patch.year ?? null;
  if (Object.prototype.hasOwnProperty.call(patch, "coverMediaId")) {
    normalized.coverMediaId = patch.coverMediaId ?? null;
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
