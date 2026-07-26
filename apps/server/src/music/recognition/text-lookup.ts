import path from "node:path";
import type { RecognitionCandidate, TextLookup } from "./types.js";

const MUSICBRAINZ_ENDPOINT = "https://musicbrainz.org/ws/2/recording";
const DEFAULT_CONTACT = "https://github.com/openai/codex/issues";
const MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 6_000;
const REQUEST_INTERVAL_MS = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type MusicBrainzTextLookupOptions = {
  request?: Fetch;
  timeoutMs?: number;
  contact?: string;
  pacer?: MusicBrainzRequestPacer;
};

export interface MusicBrainzRequestPacer {
  schedule<T>(request: () => Promise<T>): Promise<T>;
}

type PacerOptions = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export function createMusicBrainzRequestPacer(
  options: PacerOptions = {},
): MusicBrainzRequestPacer {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let tail = Promise.resolve();
  let nextAllowedAt = 0;
  return {
    schedule<T>(request: () => Promise<T>): Promise<T> {
      const scheduled = tail.then(async () => {
        const wait = Math.max(0, nextAllowedAt - now());
        if (wait > 0) await sleep(wait);
        nextAllowedAt = now() + REQUEST_INTERVAL_MS;
        return request();
      });
      tail = scheduled.then(() => undefined, () => undefined);
      return scheduled;
    },
  };
}

const sharedProductionPacer = createMusicBrainzRequestPacer();

export function createMusicBrainzTextLookup(
  options: MusicBrainzTextLookupOptions = {},
): TextLookup {
  const request = options.request ?? fetch;
  const timeoutMs = positiveTimeout(options.timeoutMs);
  const pacer = options.pacer ?? sharedProductionPacer;
  const userAgent = musicBrainzUserAgent(options.contact);

  return {
    async search({ embedded, filename }) {
      const filenameSignal = normalizeFilename(filename);
      const signals = uniqueNonEmpty([
        embedded.title,
        embedded.artist,
        embedded.album,
        filenameSignal,
      ]);
      if (signals.length === 0) return [];

      const url = new URL(MUSICBRAINZ_ENDPOINT);
      url.searchParams.set("fmt", "json");
      url.searchParams.set("limit", String(MAX_RESULTS));
      url.searchParams.set("dismax", "true");
      url.searchParams.set("query", signals.join(" "));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await pacer.schedule(() => request(url, {
          headers: {
            accept: "application/json",
            "user-agent": userAgent,
          },
          redirect: "error",
          signal: controller.signal,
        }));
        if (!response.ok) return [];
        return parseMusicBrainzResponse(await response.json());
      } catch {
        return [];
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function musicBrainzUserAgent(contact: string | undefined): string {
  const configured = contact ?? process.env.MUSICBRAINZ_CONTACT ?? DEFAULT_CONTACT;
  const safeContact = configured.replace(/[\r\n()]/g, " ").trim().slice(0, 200)
    || DEFAULT_CONTACT;
  return `LocalDiary/0.1 (${safeContact})`;
}

function parseMusicBrainzResponse(payload: unknown): RecognitionCandidate[] {
  if (!isRecord(payload) || !Array.isArray(payload.recordings)) return [];
  const candidates: RecognitionCandidate[] = [];
  for (const raw of payload.recordings.slice(0, MAX_RESULTS)) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !UUID.test(raw.id)) continue;
    const score = Number(raw.score);
    if (!Number.isFinite(score)) continue;
    const release = firstRecord(raw.releases);
    const artistCredit = firstRecord(raw["artist-credit"]);
    const artist = artistCredit && isRecord(artistCredit.artist)
      ? nullableText(artistCredit.artist.name)
      : null;
    const releaseId = release && typeof release.id === "string" && UUID.test(release.id)
      ? release.id
      : null;
    candidates.push({
      id: `musicbrainz:${raw.id}`,
      title: nullableText(raw.title),
      artist,
      album: release ? nullableText(release.title) : null,
      year: parseYear(raw["first-release-date"]),
      coverMediaId: null,
      coverReleaseId: releaseId,
      score: Math.max(0, Math.min(1, score / 100)),
      source: "text",
    });
  }
  return candidates
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, MAX_RESULTS);
}

function normalizeFilename(filename: string): string | null {
  const base = path.win32.basename(filename.replaceAll("/", "\\"));
  const withoutExtension = base.replace(/\.mp3$/i, "");
  const normalized = withoutExtension
    .replace(/[\\/:*?"<>|[\]]+/g, " ")
    .replace(/\.{2,}/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return normalized || null;
}

function uniqueNonEmpty(values: Array<string | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(
    (value): value is string => Boolean(value),
  ))];
}

function parseYear(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1000 && year <= 9999 ? year : null;
}

function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, 500) : null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveTimeout(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.min(value!, 30_000) : DEFAULT_TIMEOUT_MS;
}
