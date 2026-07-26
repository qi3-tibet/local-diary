import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { SnapshotManifest } from "@diary/contracts";
import { objectHashes, validateArchive } from "./archive.js";

export type RestorePhase = "VALIDATING" | "SAFETY_BACKUP" | "RESTORING" | "REBUILDING" | "DONE";
export type RestoreContext = {
  dataRoot: string;
  temporaryRoot: string;
  onProgress?: (phase: RestorePhase) => void;
  createSafetySnapshot?: () => Promise<void>;
  quiesce?: () => Promise<void>;
  rebuildDerivedData?: () => Promise<void>;
};

export async function restoreArchive(archivePath: string, context: RestoreContext): Promise<void> {
  const dataRoot = resolve(context.dataRoot);
  const temporaryRoot = resolve(context.temporaryRoot);
  await mkdir(temporaryRoot, { recursive: true });
  context.onProgress?.("VALIDATING");
  const validated = await validateArchive(archivePath);
  const liveDatabase = await lstat(join(dataRoot, "diary.sqlite")).catch(isMissing);
  if (liveDatabase && !context.quiesce) throw new Error("RESTORE_CONTEXT_REQUIRED");
  context.onProgress?.("SAFETY_BACKUP");
  if (liveDatabase && !context.createSafetySnapshot) throw new Error("RESTORE_SAFETY_SNAPSHOT_REQUIRED");
  await context.createSafetySnapshot?.();
  const next = `${dataRoot}.next-${randomUUID()}`;
  const old = `${dataRoot}.old-${randomUUID()}`;
  try {
    context.onProgress?.("RESTORING");
    await materialize(next, validated.manifest, validated.objects);
    await context.quiesce?.();
    const live = await lstat(dataRoot).catch(isMissing);
    if (live) await rename(dataRoot, old);
    try { await rename(next, dataRoot); }
    catch (error) { if (await lstat(old).catch(isMissing)) await rename(old, dataRoot); throw error; }
    context.onProgress?.("REBUILDING");
    try { await context.rebuildDerivedData?.(); }
    catch (error) { await rm(dataRoot, { recursive: true, force: true }); if (await lstat(old).catch(isMissing)) await rename(old, dataRoot); throw error; }
    await rm(old, { recursive: true, force: true });
    context.onProgress?.("DONE");
  } finally { await rm(next, { recursive: true, force: true }); }
}

async function materialize(root: string, manifest: SnapshotManifest, objects: Map<string, Buffer>): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, ".local-diary-restore-owner"), "1\n", { flag: "wx" });
  await writeFile(join(root, "diary.sqlite"), objects.get(manifest.databaseObject)!, { flag: "wx" });
  for (const item of manifest.mediaObjects) {
    const destination = mediaDestination(root, item.logicalPath, item.hash);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, objects.get(item.hash)!, { flag: "wx" });
  }
  objectHashes(manifest);
}

function mediaDestination(root: string, logicalPath: string, hash: string): string {
  const match = /^media\/objects\/([a-f0-9]{2})\/([a-f0-9]{64})\.[a-z0-9]+$/.exec(logicalPath);
  if (!match || match[1] !== hash.slice(0, 2) || match[2] !== hash) throw new Error("ARCHIVE_UNSAFE_MEDIA_PATH");
  const destination = resolve(root, logicalPath);
  if (!destination.startsWith(`${root}${sep}`)) throw new Error("ARCHIVE_UNSAFE_MEDIA_PATH");
  return destination;
}

function isMissing(error: unknown): null { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
