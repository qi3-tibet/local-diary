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
  tags: string[];
};
