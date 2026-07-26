import { z } from "zod";

export const backupObjectHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const snapshotManifestSchema = z.object({
  format: z.literal("local-diary-snapshot"),
  version: z.literal(1),
  id: z.string().uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  createdAt: z.string().datetime({ offset: true }),
  databaseObject: backupObjectHashSchema,
  mediaObjects: z.array(z.object({
    logicalPath: z.string().min(1),
    hash: backupObjectHashSchema,
  })).max(1_000_000),
});

export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;
