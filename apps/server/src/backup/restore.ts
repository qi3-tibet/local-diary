import { lstat, mkdir, rename, rm, writeFile, copyFile, utimes } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { SnapshotManifest } from "@diary/contracts";
import { extractAndValidateArchive } from "./archive.js";

export type RestorePhase = "VALIDATING" | "SAFETY_BACKUP" | "RESTORING" | "REBUILDING" | "DONE";
export type RestoreCoordinator = {
  /** Blocks new writers and waits for current writers; returns a release function. */
  acquireBarrier: () => Promise<() => Promise<void> | void>;
  createSafetySnapshot: () => Promise<void>;
  quiesce: () => Promise<void>;
  reopen: () => Promise<void>;
  rebuildDerivedData?: () => Promise<void>;
};
export type RestoreContext = { dataRoot: string; temporaryRoot: string; coordinator?: RestoreCoordinator; onProgress?: (phase: RestorePhase) => void; };

const restoreLocks = new Map<string, Promise<void>>(); const PROCESS_NONCE = randomUUID();

export async function restoreArchive(archivePath: string, context: RestoreContext): Promise<void> {
  const dataRoot = resolve(context.dataRoot); const temporaryRoot = resolve(context.temporaryRoot);
  await mkdir(temporaryRoot, { recursive: true });
  const staging = join(temporaryRoot, `restore-${randomUUID()}`);
  const next = `${dataRoot}.next-${randomUUID()}`; const old = `${dataRoot}.old-${randomUUID()}`;
  try {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, ".local-diary-restore-owner"), "1\n", { flag: "wx" });
    context.onProgress?.("VALIDATING");
    const extracted = await extractAndValidateArchive(archivePath, staging);
    context.onProgress?.("RESTORING");
    await materialize(next, extracted.manifest, extracted.objectsRoot);
    await withRestoreLock(dataRoot, async () => {
      const live = await lstat(join(dataRoot, "diary.sqlite")).catch(missing);
      if (live && !context.coordinator) throw new Error("RESTORE_CONTEXT_REQUIRED");
      const release = await context.coordinator?.acquireBarrier();
      let quiesced = false;
      try {
        context.onProgress?.("SAFETY_BACKUP");
        if (live) await context.coordinator!.createSafetySnapshot();
        await context.coordinator?.quiesce(); quiesced = Boolean(context.coordinator);
        const root = await lstat(dataRoot).catch(missing);
        if (root) await rename(dataRoot, old);
        try { await rename(next, dataRoot); }
        catch (error) { if (await lstat(old).catch(missing)) await rename(old, dataRoot); throw error; }
        context.onProgress?.("REBUILDING");
        try { await context.coordinator?.rebuildDerivedData?.(); }
        catch (error) {
          if (await owned(dataRoot)) await rm(dataRoot, { recursive: true, force: true });
          if (await lstat(old).catch(missing)) await rename(old, dataRoot);
          throw error;
        }
        context.onProgress?.("DONE");
      } finally {
        if (quiesced) await context.coordinator!.reopen();
        await release?.();
      }
    });
  } finally {
    await removeOwned(next); await removeOwned(staging);
  }
}

async function materialize(root: string, manifest: SnapshotManifest, objectsRoot: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, ".local-diary-restore-owner"), "1\n", { flag: "wx" });
  await copyFile(join(objectsRoot, manifest.databaseObject), join(root, "diary.sqlite"));
  for (const item of manifest.mediaObjects) {
    const destination = mediaDestination(root, item.logicalPath, item.hash);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(objectsRoot, item.hash), destination);
  }
}
function mediaDestination(root: string, logicalPath: string, hash: string): string { const match = /^media\/objects\/([a-f0-9]{2})\/([a-f0-9]{64})\.[a-z0-9]+$/.exec(logicalPath); if (!match || match[1] !== hash.slice(0, 2) || match[2] !== hash) throw new Error("ARCHIVE_UNSAFE_MEDIA_PATH"); const destination = resolve(root, logicalPath); if (!destination.startsWith(`${root}${sep}`)) throw new Error("ARCHIVE_UNSAFE_MEDIA_PATH"); return destination; }
async function owned(pathname: string): Promise<boolean> { return Boolean(await lstat(join(pathname, ".local-diary-restore-owner")).catch(missing)); }
async function removeOwned(pathname: string): Promise<void> { if (await owned(pathname)) await rm(pathname, { recursive: true, force: true }); }
async function withRestoreLock<T>(key: string, work: () => Promise<T>): Promise<T> { const previous = restoreLocks.get(key) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>((resolvePromise) => { release = resolvePromise; }); const tail = previous.then(() => current); restoreLocks.set(key, tail); await previous; const lease = await acquireLease(`${key}.restore.lock`); try { return await work(); } finally { await releaseLease(lease); release(); if (restoreLocks.get(key) === tail) restoreLocks.delete(key); } }
type Lease = { lock: string; owner: string; token: string; lost: Error | null; heartbeat: ReturnType<typeof setInterval> };
async function acquireLease(lock: string): Promise<Lease> { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { try { await mkdir(lock); const token = randomUUID(); const owner = join(lock, "owner.json"); await writeFile(owner, JSON.stringify({ token, pid: process.pid, nonce: PROCESS_NONCE }), { flag: "wx" }); const lease: Lease = { lock, owner, token, lost: null, heartbeat: undefined! }; lease.heartbeat = setInterval(() => { void utimes(lock, new Date(), new Date()).catch((error) => { lease.lost = new Error("RESTORE_LEASE_LOST", { cause: error }); }); }, 10_000); return lease; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const stat = await lstat(lock).catch(missing); if (stat && stat.isDirectory() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 10 * 60_000) { const owner = await readOwner(join(lock, "owner.json")); if (owner && !alive(owner.pid)) { const quarantine = `${lock}.steal-${randomUUID()}`; try { await rename(lock, quarantine); const claimed = await readOwner(join(quarantine, "owner.json")); if (claimed?.token === owner.token && !alive(owner.pid)) await rm(quarantine, { recursive: true, force: true }); } catch (claimError) { if ((claimError as NodeJS.ErrnoException).code !== "ENOENT" && (claimError as NodeJS.ErrnoException).code !== "EEXIST") throw claimError; } } } await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25)); } } throw new Error("RESTORE_LOCK_TIMEOUT"); }
async function releaseLease(lease: Lease): Promise<void> { clearInterval(lease.heartbeat); if (lease.lost) throw lease.lost; const owner = await readOwner(lease.owner); if (owner?.token !== lease.token || owner.pid !== process.pid || owner.nonce !== PROCESS_NONCE) throw new Error("RESTORE_LEASE_LOST"); await rm(lease.lock, { recursive: true, force: true }); }
type Owner = { token: string; pid: number; nonce: string };
async function readOwner(pathname: string): Promise<Owner | null> { try { const parsed = JSON.parse(await (await import("node:fs/promises")).readFile(pathname, "utf8")) as Partial<Owner>; return typeof parsed.token === "string" && typeof parsed.pid === "number" && typeof parsed.nonce === "string" ? parsed as Owner : null; } catch { return null; } }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
function missing(error: unknown): null { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
