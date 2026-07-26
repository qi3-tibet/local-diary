import { z } from "zod";

export const entryStateSchema = z.enum(["draft", "published", "trashed"]);
export const draftInputSchema = z.object({
  title: z.string(),
  markdown: z.string(),
  tags: z.array(z.string().trim().min(1)).default([]),
});

export type DraftInput = z.infer<typeof draftInputSchema>;

export type Entry = {
  id: string;
  title: string;
  markdown: string;
  state: z.infer<typeof entryStateSchema>;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  edited: boolean;
  tags: string[];
};

export const musicMetadataSchema = z.object({
  mediaId: z.string().uuid(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  year: z.number().int().nullable(),
  coverMediaId: z.string().uuid().nullable(),
  coverMime: z.string().nullable(),
  recognitionStatus: z.enum(["embedded", "manual_required", "candidates", "recognized", "manual"]),
});

export type MusicMetadata = z.infer<typeof musicMetadataSchema>;

export const recognitionCandidateSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  year: z.number().int().min(1000).max(9999).nullable(),
  coverMediaId: z.string().uuid().nullable(),
  coverReleaseId: z.string().uuid().nullable(),
  score: z.number().min(0).max(1),
  source: z.enum(["text", "fingerprint"]),
});

export type RecognitionCandidate = z.infer<typeof recognitionCandidateSchema>;

export const musicMetadataOverrideSchema = z.object({
  title: z.string().trim().max(500).nullable().optional(),
  artist: z.string().trim().max(500).nullable().optional(),
  album: z.string().trim().max(500).nullable().optional(),
  year: z.number().int().min(1000).max(9999).nullable().optional(),
  coverMediaId: z.string().uuid().nullable().optional(),
}).strict();

export type MusicMetadataOverride = z.infer<typeof musicMetadataOverrideSchema>;
