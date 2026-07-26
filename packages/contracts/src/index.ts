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
  recognitionStatus: z.enum(["embedded", "manual_required"]),
});

export type MusicMetadata = z.infer<typeof musicMetadataSchema>;
