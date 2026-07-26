import { lstat, mkdir, rename, rm, writeFile, copyFile, utimes } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { SnapshotManifest } from "@diary/contracts";
import { extractAndValidateArchive } from "./archive.js";
import Database from "better-sqlite3";

export type RestorePhase = "VALIDATING" | "SAFETY_BACKUP" | "RESTORING" | "REBUILDING" | "DONE";
export type RestoreCoordinator = {
  /** Blocks new writers and waits for current writers; returns a release function. */
  acquireBarrier: () => Promise<() => Promise<void> | void>;
  createSafetySnapshot: () => Promise<string | void>;
  quiesce: () => Promise<void>;
  reopen: () => Promise<void>;
  rebuildDerivedData?: () => Promise<void>;
};
export type RestoreOperations = { rename?: (from: string, to: string) => Promise<void>; remove?: (pathname: string) => Promise<void>; afterLeaseRelease?: () => Promise<void>; };
export type RestoreContext = { dataRoot: string; temporaryRoot: string; coordinator?: RestoreCoordinator; onProgress?: (phase: RestorePhase) => void; onSafetySnapshot?: (id: string) => void; operations?: RestoreOperations; };

const restoreLocks = new Map<string, Promise<void>>(); const PROCESS_NONCE = randomUUID();

export async function restoreArchive(archivePath: string, context: RestoreContext): Promise<void> {
  const dataRoot = resolve(context.dataRoot); const temporaryRoot = resolve(context.temporaryRoot);
  const move = context.operations?.rename ?? rename;
  const removeDirectory = context.operations?.remove ?? ((pathname: string) => rm(pathname, { recursive: true, force: true }));
  await mkdir(temporaryRoot, { recursive: true });
  const staging = join(temporaryRoot, `restore-${randomUUID()}`);
  const next = `${dataRoot}.next-${randomUUID()}`; const old = `${dataRoot}.old-${randomUUID()}`;
  try {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, ".local-diary-restore-owner"), "1\n", { flag: "wx" });
    context.onProgress?.("VALIDATING");
    const extracted = await extractAndValidateArchive(archivePath, staging);
    await materialize(next, extracted.manifest, extracted.objectsRoot);
    preflightDatabase(join(next, "diary.sqlite"));
    await withRestoreLock(dataRoot, async () => {
      const live = await lstat(join(dataRoot, "diary.sqlite")).catch(missing);
      if (live && !context.coordinator) throw new Error("RESTORE_CONTEXT_REQUIRED");
      const release = await context.coordinator?.acquireBarrier();
      let quiesced = false;
      let oldMoved = false;
      let replacementLive = false;
      let servicesOpen = false;
      let resumeGate = true;
      try {
        context.onProgress?.("SAFETY_BACKUP");
        if (live) {
          const safetySnapshotId = await context.coordinator!.createSafetySnapshot();
          if (safetySnapshotId) context.onSafetySnapshot?.(safetySnapshotId);
        }
        context.onProgress?.("RESTORING");
        await context.coordinator?.quiesce();
        quiesced = Boolean(context.coordinator);
        const root = await lstat(dataRoot).catch(missing);
        if (root) {
          await move(dataRoot, old);
          oldMoved = true;
          // A successful earlier restore leaves this marker on its now-live
          // directory.  Moving that directory to `old` again is still safe;
          // ownership is preserved rather than treated as a collision.
          try { await writeFile(join(old, ".local-diary-restore-owner"), "1\n", { flag: "a" }); }
          catch (error) {
            await move(old, dataRoot);
            oldMoved = false;
            throw error;
          }
        }
        await move(next, dataRoot);
        replacementLive = true;
        context.onProgress?.("REBUILDING");
        await context.coordinator?.rebuildDerivedData?.();
        // Opening the new database is part of the commit.  It must remain in
        // the rollback region: a bad candidate is never left live merely
        // because its filesystem swap succeeded.
        await context.coordinator?.reopen();
        servicesOpen = Boolean(context.coordinator);
        context.onProgress?.("DONE");
        if (oldMoved) await removeOwned(old, removeDirectory);
      } finally {
        if (quiesced && !servicesOpen) {
          const rolledBack = await rollbackToOld({ dataRoot, old, oldMoved, replacementLive, move, removeDirectory });
          if (rolledBack) {
            try {
              await context.coordinator!.reopen();
              servicesOpen = true;
            } catch (error) {
              // The bytes are back, but no service is safely serving them.
              // Keep the request gate closed rather than reopening an empty or
              // partially initialized diary.
              resumeGate = false;
              throw new Error("RESTORE_RECOVERY_REQUIRED", { cause: error });
            }
          } else if (oldMoved || replacementLive) {
            // `old` is intentionally retained as the only trusted recovery
            // directory.  Do not synthesize a new data root here.
            resumeGate = false;
            throw new Error(`RESTORE_RECOVERY_REQUIRED:${old}`);
          } else {
            await context.coordinator!.reopen();
            servicesOpen = true;
          }
        }
        if (resumeGate) await release?.();
      }
    }, context.operations?.afterLeaseRelease);
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
function preflightDatabase(pathname: string): void { let database: Database.Database | undefined; try { database = new Database(pathname, { readonly: true, fileMustExist: true }); const quick = database.pragma("quick_check", { simple: true }); const version = database.pragma("user_version", { simple: true }) as number; const entry = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'").get(); if (quick !== "ok" || version < 8 || !entry) throw new Error("ARCHIVE_DATABASE_INVALID"); } catch (error) { if (error instanceof Error && error.message === "ARCHIVE_DATABASE_INVALID") throw error; throw new Error("ARCHIVE_DATABASE_INVALID", { cause: error }); } finally { database?.close(); } }
function mediaDestination(root: string, logicalPath: string, hash: string): string { const match = /^media\/objects\/([a-f0-9]{2})\/([a-f0-9]{64})\.[a-z0-9]+$/.exec(logicalPath); if (!match || match[1] !== hash.slice(0, 2) || match[2] !== hash) throw new Error("ARCHIVE_UNSAFE_MEDIA_PATH"); const destination = resolve(root, logicalPath); if (!destination.startsWith(`${root}${sep}`)) throw new Error("ARCHIVE_UNSAFE_MEDIA_PATH"); return destination; }
async function owned(pathname: string): Promise<boolean> { return Boolean(await lstat(join(pathname, ".local-diary-restore-owner")).catch(missing)); }
async function removeOwned(pathname: string, removeDirectory = (target: string) => rm(target, { recursive: true, force: true })): Promise<void> { if (await owned(pathname)) await removeDirectory(pathname); }
async function rollbackToOld(state: { dataRoot: string; old: string; oldMoved: boolean; replacementLive: boolean; move: (from: string, to: string) => Promise<void>; removeDirectory: (pathname: string) => Promise<void> }): Promise<boolean> {
  if (!state.oldMoved) return !state.replacementLive;
  try {
    // Never remove a directory that this restore did not create.  If removal
    // fails, leave both paths alone and retain the write barrier.
    if (state.replacementLive) {
      if (!await owned(state.dataRoot)) return false;
      await state.removeDirectory(state.dataRoot);
    }
    if (!await lstat(state.old).catch(missing)) return false;
    await state.move(state.old, state.dataRoot);
    await rm(join(state.dataRoot, ".local-diary-restore-owner"), { force: true });
    return true;
  } catch {
    return false;
  }
}
async function withRestoreLock<T>(key: string, work: () => Promise<T>, afterLeaseRelease?: () => Promise<void>): Promise<T> { const previous = restoreLocks.get(key) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>((resolvePromise) => { release = resolvePromise; }); const tail = previous.then(() => current); restoreLocks.set(key, tail); await previous; let lease: Lease | undefined; try { lease = await acquireLease(`${key}.restore.lock`); return await work(); } finally { try { if (lease) { await releaseLease(lease); await afterLeaseRelease?.(); } } finally { release(); if (restoreLocks.get(key) === tail) restoreLocks.delete(key); } } }
type Lease = { lock: string; owner: string; token: string; lost: Error | null; heartbeat: ReturnType<typeof setInterval> };
async function acquireLease(lock: string): Promise<Lease> { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { try { await mkdir(lock); const token = randomUUID(); const owner = join(lock, "owner.json"); await writeFile(owner, JSON.stringify({ token, pid: process.pid, nonce: PROCESS_NONCE }), { flag: "wx" }); const lease: Lease = { lock, owner, token, lost: null, heartbeat: undefined! }; lease.heartbeat = setInterval(() => { void utimes(lock, new Date(), new Date()).catch((error) => { lease.lost = new Error("RESTORE_LEASE_LOST", { cause: error }); }); }, 10_000); return lease; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const stat = await lstat(lock).catch(missing); if (stat && stat.isDirectory() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 10 * 60_000) { const owner = await readOwner(join(lock, "owner.json")); if (owner && !alive(owner.pid)) { const quarantine = `${lock}.steal-${randomUUID()}`; try { await rename(lock, quarantine); const claimed = await readOwner(join(quarantine, "owner.json")); if (claimed?.token === owner.token && !alive(owner.pid)) await rm(quarantine, { recursive: true, force: true }); } catch (claimError) { if ((claimError as NodeJS.ErrnoException).code !== "ENOENT" && (claimError as NodeJS.ErrnoException).code !== "EEXIST") throw claimError; } } } await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25)); } } throw new Error("RESTORE_LOCK_TIMEOUT"); }
async function releaseLease(lease: Lease): Promise<void> { clearInterval(lease.heartbeat); if (lease.lost) throw lease.lost; const owner = await readOwner(lease.owner); if (owner?.token !== lease.token || owner.pid !== process.pid || owner.nonce !== PROCESS_NONCE) throw new Error("RESTORE_LEASE_LOST"); await rm(lease.lock, { recursive: true, force: true }); }
type Owner = { token: string; pid: number; nonce: string };
async function readOwner(pathname: string): Promise<Owner | null> { try { const parsed = JSON.parse(await (await import("node:fs/promises")).readFile(pathname, "utf8")) as Partial<Owner>; return typeof parsed.token === "string" && typeof parsed.pid === "number" && typeof parsed.nonce === "string" ? parsed as Owner : null; } catch { return null; } }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
function missing(error: unknown): null { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
