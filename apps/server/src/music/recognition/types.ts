export type MusicFields = {
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  coverMediaId: string | null;
};

export type PartialMusicMetadata = MusicFields;

export type RecognitionCandidate = MusicFields & {
  id: string;
  score: number;
  source: "text" | "fingerprint";
  coverReleaseId: string | null;
};

export type MusicOverrides = Partial<MusicFields>;

export type TextLookupInput = {
  embedded: PartialMusicMetadata;
  filename: string;
};

export interface TextLookup {
  search(input: TextLookupInput): Promise<RecognitionCandidate[]>;
}

export interface FingerprintLookup {
  search(filePath: string): Promise<RecognitionCandidate[]>;
}

export type RecognitionResult = {
  source: "text" | "fingerprint" | "manual";
  candidates: RecognitionCandidate[];
  manualRequired: boolean;
};
