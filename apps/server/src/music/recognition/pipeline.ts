import type {
  FingerprintLookup,
  MusicFields,
  MusicOverrides,
  PartialMusicMetadata,
  RecognitionCandidate,
  RecognitionResult,
  TextLookup,
} from "./types.js";

export const CONFIDENT_TEXT_SCORE = 0.9;
const MAX_CANDIDATES = 5;

export async function recognizeMusic(
  embedded: PartialMusicMetadata,
  filename: string,
  textLookup: TextLookup,
  fingerprintLookup: FingerprintLookup,
  filePath = "",
): Promise<RecognitionResult> {
  const textCandidates = normalizeCandidates(
    await safely(() => textLookup.search({ embedded, filename })),
    "text",
  );

  if (textCandidates.length === 1 && textCandidates[0]!.score >= CONFIDENT_TEXT_SCORE) {
    return { source: "text", candidates: textCandidates, manualRequired: false };
  }

  const fingerprintCandidates = normalizeCandidates(
    await safely(() => fingerprintLookup.search(filePath)),
    "fingerprint",
  );
  if (fingerprintCandidates.length > 0) {
    return {
      source: "fingerprint",
      candidates: fingerprintCandidates,
      manualRequired: false,
    };
  }
  if (textCandidates.length > 0) {
    return { source: "text", candidates: textCandidates, manualRequired: false };
  }
  return { source: "manual", candidates: [], manualRequired: true };
}

export function applyOverrides<T extends MusicFields>(
  metadata: T,
  overrides: MusicOverrides,
): T {
  return {
    ...metadata,
    title: hasOwn(overrides, "title") ? overrides.title! : metadata.title,
    artist: hasOwn(overrides, "artist") ? overrides.artist! : metadata.artist,
    album: hasOwn(overrides, "album") ? overrides.album! : metadata.album,
    year: hasOwn(overrides, "year") ? overrides.year! : metadata.year,
    coverMediaId: hasOwn(overrides, "coverMediaId")
      ? overrides.coverMediaId!
      : metadata.coverMediaId,
  };
}

function normalizeCandidates(
  candidates: RecognitionCandidate[],
  expectedSource: RecognitionCandidate["source"],
): RecognitionCandidate[] {
  const byId = new Map<string, RecognitionCandidate>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id) continue;
    if (!Number.isFinite(candidate.score)) continue;
    const normalized = {
      ...candidate,
      score: Math.max(0, Math.min(1, candidate.score)),
      source: expectedSource,
    };
    const current = byId.get(normalized.id);
    if (!current || normalized.score > current.score) byId.set(normalized.id, normalized);
  }
  return [...byId.values()]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, MAX_CANDIDATES);
}

async function safely(work: () => Promise<RecognitionCandidate[]>): Promise<RecognitionCandidate[]> {
  try {
    const candidates = await work();
    return Array.isArray(candidates) ? candidates : [];
  } catch {
    return [];
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
