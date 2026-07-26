import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { snapshotManifestSchema, type SnapshotManifest } from "@diary/contracts";
import type { DiaryDatabase } from "../db/client.js";
import { BackupObjectStore } from "./object-store.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA_FILE = /^[a-f0-9]{64}\.[a-z0-9]+$/;
const INTERRUPTED_MANIFEST = /^[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/;
const INTERRUPTED_MEDIA = /^[a-f0-9]{64}\.[a-z0-9]+\.[0-9a-f-]{36}\.tmp$/;
const TEMPORARY_DATABASE = /^[0-9a-f-]{36}\.sqlite$/;
const TEMPORARY_RUN = /^[0-9a-f-]{36}$/;
const RUN_MARKER = "run.json";
const RUN_FORMAT = "local-diary-backup-run";
const SNAPSHOT_LOCK_WAIT_MS = 25;
const SNAPSHOT_LOCK_TIMEOUT_MS = 30_000;
const SNAPSHOT_LOCK_STALE_MS = 10 * 60_000;
const PROCESS_START_NONCE = randomUUID();

export type SnapshotInfo = SnapshotManifest & { objects: string[] };

export type SnapshotServiceOptions = {
  dataRoot: string;
  backupRoot: string;
  database: DiaryDatabase;
  leaseHeartbeat?: (path: string) => Promise<void>;
  beforeLeaseStealClaim?: () => Promise<void>;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  processId?: number;
  processStartNonce?: string;
  lockTimeoutMs?: number;
  leaseHeartbeatIntervalMs?: number;
  writeManifestTemporary?: (path: string, contents: string) => Promise<void>;
};

type SnapshotLease = {
  lock: string;
  owner: string;
  token: string;
  lost: Error | null;
  heartbeat: ReturnType<typeof setInterval>;
  heartbeatTail: Promise<void>;
  heartbeatsStopped: boolean;
  runMarkers: Set<string>;
};

export class SnapshotService {
  private static readonly locks = new Map<string, Promise<void>>();
  private readonly dataRoot: string;
  private readonly backupRoot: string;
  private readonly manifestsRoot: string;
  private readonly database: DiaryDatabase;
  private readonly heartbeatLeasePath: (path: string) => Promise<void>;
  private readonly beforeLeaseStealClaim: (() => Promise<void>) | undefined;
  private readonly now: () => Date;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly processId: number;
  private readonly processStartNonce: string;
  private readonly lockTimeoutMs: number;
  private readonly leaseHeartbeatIntervalMs: number;
  private readonly writeManifestTemporary: ((path: string, contents: string) => Promise<void>) | undefined;
  readonly objects: BackupObjectStore;

  constructor(options: SnapshotServiceOptions) {
    this.dataRoot = resolve(options.dataRoot);
    this.backupRoot = resolve(options.backupRoot);
    this.manifestsRoot = join(this.backupRoot, "manifests");
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.heartbeatLeasePath = options.leaseHeartbeat ?? (async (pathname) => {
      const now = this.now();
      await utimes(pathname, now, now);
    });
    this.beforeLeaseStealClaim = options.beforeLeaseStealClaim;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.processId = options.processId ?? process.pid;
    this.processStartNonce = options.processStartNonce ?? PROCESS_START_NONCE;
    this.lockTimeoutMs = options.lockTimeoutMs ?? SNAPSHOT_LOCK_TIMEOUT_MS;
    this.leaseHeartbeatIntervalMs = options.leaseHeartbeatIntervalMs ?? 60_000;
    this.writeManifestTemporary = options.writeManifestTemporary;
    this.objects = new BackupObjectStore(this.backupRoot);
  }

  async create(day: string): Promise<SnapshotInfo> {
    return (await this.ensure(day)).snapshot;
  }

  async ensure(day: string): Promise<{ snapshot: SnapshotInfo; created: boolean }> {
    if (!DAY.test(day)) throw new Error("Invalid Beijing backup day");
    return this.withLock(async (lease) => {
      await this.cleanupInterruptedArtifacts();
      await this.collectUnreferencedObjects();
      const current = await this.findByDay(day);
      if (current) return { snapshot: asInfo(current), created: false };

      const databaseObject = await this.backupDatabase(lease);
      const mediaObjects = await this.inventoryMedia();
      await this.refreshLease(lease);
      const manifest = snapshotManifestSchema.parse({
        format: "local-diary-snapshot",
        version: 1,
        id: randomUUID(),
        day,
        createdAt: new Date().toISOString(),
        databaseObject,
        mediaObjects,
      });

      const preparedManifest = await this.prepareManifest(manifest);
      try {
        await this.beginManifestCommit(lease);
        await this.publishManifest(preparedManifest);
      } catch (error) {
        await rm(preparedManifest.temporary, { force: true });
        throw error;
      }
      await this.prune();
      return { snapshot: asInfo(manifest), created: true };
    });
  }

  async list(): Promise<SnapshotInfo[]> {
    const directory = await lstat(this.manifestsRoot).catch((error) => isMissing(error) ? null : Promise.reject(error));
    if (!directory) return [];
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("BACKUP_UNSAFE_MANIFEST_PATH");
    const manifests: SnapshotManifest[] = [];
    for (const file of await readdir(this.manifestsRoot, { withFileTypes: true })) {
      if (file.isFile() && INTERRUPTED_MANIFEST.test(file.name)) continue;
      if (!file.isFile() || file.isSymbolicLink() || !/^[0-9a-f-]{36}\.json$/.test(file.name)) {
        throw new Error("BACKUP_UNSAFE_MANIFEST_PATH");
      }
      manifests.push(await this.readManifest(join(this.manifestsRoot, file.name)));
    }
    return manifests.sort(compareManifests).map(asInfo);
  }

  async restore(id: string, target: string): Promise<void> {
    const manifest = await this.get(id);
    const resolvedTarget = resolve(target);
    const parent = dirname(resolvedTarget);
    const parentStat = await lstat(parent).catch((error) => isMissing(error) ? null : Promise.reject(error));
    if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("BACKUP_RESTORE_TARGET_INVALID");
    const targetStat = await lstat(resolvedTarget).catch((error) => isMissing(error) ? null : Promise.reject(error));
    if (targetStat) throw new Error("BACKUP_RESTORE_TARGET_EXISTS");

    manifest.mediaObjects.forEach((media) => safeMediaDestination(resolvedTarget, media.logicalPath, media.hash));
    const objects = [manifest.databaseObject, ...manifest.mediaObjects.map((item) => item.hash)];
    const verified = new Map<string, Buffer>();
    for (const hash of [...new Set(objects)]) verified.set(hash, await this.objects.readVerified(hash));

    const staging = join(parent, `.${basename(resolvedTarget)}.restore-${randomUUID()}`);
    try {
      await mkdir(join(staging, "media", "objects"), { recursive: true });
      await writeFile(join(staging, "diary.sqlite"), verified.get(manifest.databaseObject)! , { flag: "wx" });
      for (const media of manifest.mediaObjects) {
        const destination = safeMediaDestination(staging, media.logicalPath, media.hash);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, verified.get(media.hash)!, { flag: "wx" });
      }
      const appeared = await lstat(resolvedTarget).catch((error) => isMissing(error) ? null : Promise.reject(error));
      if (appeared) throw new Error("BACKUP_RESTORE_TARGET_EXISTS");
      await rename(staging, resolvedTarget);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async hasDay(day: string): Promise<boolean> {
    return (await this.findByDay(day)) !== null;
  }

  getLastScheduledDay(): string | null {
    const row = this.database.prepare("SELECT value FROM backup_state WHERE key = 'last_scheduled_day'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  recordScheduledDay(day: string): void {
    if (!DAY.test(day)) throw new Error("Invalid Beijing backup day");
    this.database.prepare(`
      INSERT INTO backup_state (key, value, updated_at) VALUES ('last_scheduled_day', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(day, new Date().toISOString());
  }

  private async backupDatabase(lease: SnapshotLease): Promise<string> {
    const temporaryRoot = join(this.backupRoot, ".tmp");
    await mkdir(temporaryRoot, { recursive: true });
    const runRoot = join(temporaryRoot, randomUUID());
    await mkdir(runRoot);
    const destination = join(runRoot, "snapshot.sqlite");
    const marker = join(runRoot, RUN_MARKER);
    await this.writeRunMarker(marker, lease);
    lease.runMarkers.add(marker);
    try {
      await this.database.backup(destination);
      await this.refreshLease(lease);
      return await this.objects.put(await readFile(destination));
    } finally {
      lease.runMarkers.delete(marker);
      await rm(runRoot, { recursive: true, force: true });
    }
  }

  private async inventoryMedia(): Promise<SnapshotManifest["mediaObjects"]> {
    const mediaRoot = join(this.dataRoot, "media");
    const stat = await lstat(mediaRoot).catch((error) => isMissing(error) ? null : Promise.reject(error));
    if (!stat) return [];
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("BACKUP_UNSAFE_MEDIA_PATH");
    const files: Array<{ logicalPath: string; source: string }> = [];
    await collectMediaFiles(mediaRoot, mediaRoot, files);
    const result: SnapshotManifest["mediaObjects"] = [];
    for (const file of files.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))) {
      const bytes = await readFile(file.source);
      const hash = await this.objects.put(bytes);
      const expectedHash = file.logicalPath.split("/").at(-1)!.split(".")[0]!;
      const prefix = file.logicalPath.split("/")[2]!;
      if (hash !== expectedHash || prefix !== hash.slice(0, 2)) throw new Error("BACKUP_MEDIA_HASH_MISMATCH");
      result.push({ logicalPath: file.logicalPath, hash });
    }
    return result;
  }

  private async prepareManifest(manifest: SnapshotManifest): Promise<{ temporary: string; destination: string }> {
    await mkdir(this.manifestsRoot, { recursive: true });
    const destination = this.manifestPath(manifest.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const contents = `${JSON.stringify(manifest)}\n`;
    if (this.writeManifestTemporary) {
      await this.writeManifestTemporary(temporary, contents);
    } else {
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return { temporary, destination };
  }

  private async beginManifestCommit(lease: SnapshotLease): Promise<void> {
    await this.stopHeartbeats(lease);
    await this.assertLeaseOwnership(lease);
  }

  private async publishManifest(prepared: { temporary: string; destination: string }): Promise<void> {
    await rename(prepared.temporary, prepared.destination);
  }

  private async prune(): Promise<void> {
    const all = await this.list();
    const newestByDay = new Map<string, SnapshotInfo>();
    for (const manifest of all) newestByDay.set(manifest.day, manifest);
    const kept = [...newestByDay.values()].sort(compareManifests).slice(-30);
    const keep = new Set(kept.map((manifest) => manifest.id));
    for (const manifest of all) {
      if (!keep.has(manifest.id)) await rm(this.manifestPath(manifest.id), { force: true });
    }
    await this.collectUnreferencedObjects();
  }

  private async collectUnreferencedObjects(): Promise<void> {
    const references = new Set<string>();
    for (const manifest of await this.list()) {
      references.add(manifest.databaseObject);
      manifest.mediaObjects.forEach((media) => references.add(media.hash));
    }
    for (const hash of await this.objects.allHashes()) {
      if (!references.has(hash)) await this.objects.remove(hash);
    }
  }

  private async cleanupInterruptedArtifacts(): Promise<void> {
    const manifests = await lstat(this.manifestsRoot).catch((error) => isMissing(error) ? null : Promise.reject(error));
    if (manifests) {
      if (!manifests.isDirectory() || manifests.isSymbolicLink()) throw new Error("BACKUP_UNSAFE_MANIFEST_PATH");
      for (const file of await readdir(this.manifestsRoot, { withFileTypes: true })) {
        if (file.isFile() && INTERRUPTED_MANIFEST.test(file.name)) await rm(join(this.manifestsRoot, file.name), { force: true });
      }
    }
    await this.objects.cleanupInterruptedObjects();
    await this.cleanupInterruptedTemporaryDatabases();
  }

  private async cleanupInterruptedTemporaryDatabases(): Promise<void> {
    const temporaryRoot = join(this.backupRoot, ".tmp");
    const root = await lstat(temporaryRoot).catch((error) => isMissing(error) ? null : Promise.reject(error));
    if (!root) return;
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("BACKUP_UNSAFE_TEMPORARY_PATH");
    for (const item of await readdir(temporaryRoot, { withFileTypes: true })) {
      const pathname = join(temporaryRoot, item.name);
      const stat = await lstat(pathname);
      if (stat.isSymbolicLink()) continue;
      if (stat.isFile() && TEMPORARY_DATABASE.test(item.name)) {
        await rm(pathname, { force: true });
        continue;
      }
      if (!stat.isDirectory() || !TEMPORARY_RUN.test(item.name)) continue;
      const children = await readdir(pathname, { withFileTypes: true });
      const marker = children.find((child) => child.name === RUN_MARKER);
      const allowed = children.every((child) => child.name === RUN_MARKER || child.name === "snapshot.sqlite");
      if (!marker || !marker.isFile() || marker.isSymbolicLink() || !allowed) continue;
      const markerPath = join(pathname, RUN_MARKER);
      const markerStat = await lstat(markerPath);
      const markerData = await readRunMarker(markerPath);
      if (!markerData || !isStale(markerData, markerStat.mtimeMs, this.now())) continue;
      const snapshot = children.find((child) => child.name === "snapshot.sqlite");
      if (snapshot && (!snapshot.isFile() || snapshot.isSymbolicLink())) continue;
      await rm(pathname, { recursive: true, force: true });
    }
  }

  private async get(id: string): Promise<SnapshotManifest> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("BACKUP_SNAPSHOT_NOT_FOUND");
    try {
      return await this.readManifest(this.manifestPath(id));
    } catch (error) {
      if (isMissing(error)) throw new Error("BACKUP_SNAPSHOT_NOT_FOUND");
      throw error;
    }
  }

  private async findByDay(day: string): Promise<SnapshotManifest | null> {
    const matches = (await this.list()).filter((manifest) => manifest.day === day);
    return matches.at(-1) ?? null;
  }

  private async readManifest(pathname: string): Promise<SnapshotManifest> {
    const stat = await lstat(pathname);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("BACKUP_UNSAFE_MANIFEST_PATH");
    try {
      return snapshotManifestSchema.parse(JSON.parse(await readFile(pathname, "utf8")));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("BACKUP_MANIFEST_INVALID");
      throw error;
    }
  }

  private manifestPath(id: string): string {
    return join(this.manifestsRoot, `${id}.json`);
  }

  private async withLock<T>(work: (lease: SnapshotLease) => Promise<T>): Promise<T> {
    const key = this.backupRoot;
    const previous = SnapshotService.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    SnapshotService.locks.set(key, tail);
    await previous;
    try {
      const lease = await this.acquireFilesystemLock();
      try {
        return await work(lease);
      } finally {
        await this.releaseFilesystemLock(lease);
      }
    } finally {
      release();
      if (SnapshotService.locks.get(key) === tail) SnapshotService.locks.delete(key);
    }
  }

  private async acquireFilesystemLock(): Promise<SnapshotLease> {
    const locksRoot = join(this.backupRoot, ".locks");
    await mkdir(locksRoot, { recursive: true });
    const root = await lstat(locksRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("BACKUP_UNSAFE_LOCK_PATH");
    await this.cleanupStealQuarantines(locksRoot);
    const lock = join(locksRoot, "snapshot-create.lock");
    const deadline = Date.now() + this.lockTimeoutMs;
    while (Date.now() < deadline) {
      try {
        await mkdir(lock);
        const token = randomUUID();
        const owner = join(lock, "owner.json");
        await writeFile(owner, JSON.stringify({
          token,
          pid: this.processId,
          processStartNonce: this.processStartNonce,
          createdAt: this.now().toISOString(),
        }), { flag: "wx" });
        const lease: SnapshotLease = {
          lock,
          owner,
          token,
          lost: null,
          heartbeat: undefined!,
          heartbeatTail: Promise.resolve(),
          heartbeatsStopped: false,
          runMarkers: new Set(),
        };
        lease.heartbeat = setInterval(() => { this.scheduleHeartbeat(lease); }, this.leaseHeartbeatIntervalMs);
        return lease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await lstat(lock).catch((candidate) => isMissing(candidate) ? null : Promise.reject(candidate));
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("BACKUP_UNSAFE_LOCK_PATH");
        if (Date.now() - stat.mtimeMs > SNAPSHOT_LOCK_STALE_MS) {
          await this.tryClaimStaleLock(lock, stat.mtimeMs);
          continue;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_LOCK_WAIT_MS));
      }
    }
    throw new Error("BACKUP_LOCK_TIMEOUT");
  }

  private async releaseFilesystemLock(lease: SnapshotLease): Promise<void> {
    await this.stopHeartbeats(lease, false);
    const current = await readLeaseOwner(lease.owner);
    if (current?.token === lease.token) await rm(lease.lock, { recursive: true, force: true });
  }

  private async tryClaimStaleLock(lock: string, observedMtimeMs: number): Promise<void> {
    const capturedOwner = await readLeaseOwner(join(lock, "owner.json"));
    if (!capturedOwner || this.isProcessAlive(capturedOwner.pid)) return;
    await this.beforeLeaseStealClaim?.();
    const currentStat = await lstat(lock).catch((error) => isMissing(error) ? null : Promise.reject(error));
    const currentOwner = await readLeaseOwner(join(lock, "owner.json"));
    if (!currentStat || currentStat.mtimeMs !== observedMtimeMs || !sameLeaseOwner(currentOwner, capturedOwner)
      || this.isProcessAlive(capturedOwner.pid)) return;
    const quarantine = `${lock}.steal-${randomUUID()}`;
    try {
      await rename(lock, quarantine);
    } catch (error) {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    const claimedStat = await lstat(quarantine).catch((error) => isMissing(error) ? null : Promise.reject(error));
    const claimedOwner = await readLeaseOwner(join(quarantine, "owner.json"));
    if (claimedStat && claimedStat.mtimeMs === observedMtimeMs && sameLeaseOwner(claimedOwner, capturedOwner)
      && !this.isProcessAlive(capturedOwner.pid)) {
      await rm(quarantine, { recursive: true, force: true });
    }
  }

  private async refreshLease(lease: SnapshotLease): Promise<void> {
    await this.assertLeaseOwnership(lease);
    try {
      await this.heartbeatLeasePath(lease.lock);
      for (const marker of lease.runMarkers) {
        const now = this.now();
        await utimes(marker, now, now);
      }
    } catch (error) {
      lease.lost = asLeaseLost(error);
      throw lease.lost;
    }
  }

  private scheduleHeartbeat(lease: SnapshotLease): void {
    if (lease.heartbeatsStopped) return;
    lease.heartbeatTail = lease.heartbeatTail.then(
      () => this.refreshLease(lease),
      () => this.refreshLease(lease),
    ).catch((error) => {
      lease.lost = asLeaseLost(error);
    });
  }

  private async stopHeartbeats(lease: SnapshotLease, throwOnFailure = true): Promise<void> {
    if (!lease.heartbeatsStopped) {
      lease.heartbeatsStopped = true;
      clearInterval(lease.heartbeat);
    }
    await lease.heartbeatTail;
    if (throwOnFailure && lease.lost) throw lease.lost;
  }

  private async assertLeaseOwnership(lease: SnapshotLease): Promise<void> {
    if (lease.lost) throw lease.lost;
    const owner = await readLeaseOwner(lease.owner);
    if (!owner || owner.token !== lease.token || owner.pid !== this.processId || owner.processStartNonce !== this.processStartNonce) {
      lease.lost = new Error("BACKUP_LEASE_LOST");
      throw lease.lost;
    }
  }

  private async cleanupStealQuarantines(locksRoot: string): Promise<void> {
    for (const item of await readdir(locksRoot, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink() || !/^snapshot-create\.lock\.steal-[0-9a-f-]{36}$/.test(item.name)) continue;
      const quarantine = join(locksRoot, item.name);
      const owner = await readLeaseOwner(join(quarantine, "owner.json"));
      const children = await readdir(quarantine, { withFileTypes: true });
      if (owner && !this.isProcessAlive(owner.pid) && children.length === 1 && children[0]!.name === "owner.json"
        && children[0]!.isFile() && !children[0]!.isSymbolicLink()) {
        await rm(quarantine, { recursive: true, force: true });
      }
    }
  }

  private async writeRunMarker(marker: string, lease: SnapshotLease): Promise<void> {
    const now = this.now().toISOString();
    const temporary = `${marker}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({
      format: RUN_FORMAT,
      version: 1,
      token: lease.token,
      pid: process.pid,
      startedAt: now,
      heartbeatAt: now,
    }), { flag: "wx" });
    await rename(temporary, marker);
  }
}

function asInfo(manifest: SnapshotManifest): SnapshotInfo {
  return { ...manifest, objects: [manifest.databaseObject, ...manifest.mediaObjects.map((item) => item.hash)] };
}

function compareManifests(left: SnapshotManifest, right: SnapshotManifest): number {
  return left.day.localeCompare(right.day) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

async function collectMediaFiles(root: string, directory: string, output: Array<{ logicalPath: string; source: string }>): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const source = join(directory, item.name);
    const stat = await lstat(source);
    if (stat.isSymbolicLink()) throw new Error("BACKUP_UNSAFE_MEDIA_PATH");
    if (stat.isFile() && INTERRUPTED_MEDIA.test(item.name)) {
      await rm(source, { force: true });
      continue;
    }
    if (stat.isDirectory()) {
      await collectMediaFiles(root, source, output);
      continue;
    }
    if (!stat.isFile()) throw new Error("BACKUP_UNSAFE_MEDIA_PATH");
    const logicalPath = relative(root, source).split(sep).join("/");
    if (!/^objects\/[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9]+$/.test(logicalPath) || !MEDIA_FILE.test(logicalPath.slice("objects/".length).split("/").at(-1)!)) {
      throw new Error("BACKUP_UNSAFE_MEDIA_PATH");
    }
    output.push({ logicalPath: `media/${logicalPath}`, source });
  }
}

function safeMediaDestination(staging: string, logicalPath: string, expectedHash: string): string {
  if (!logicalPath.startsWith("media/")) throw new Error("BACKUP_UNSAFE_MEDIA_PATH");
  const relativePath = logicalPath.slice("media/".length);
  const match = /^objects\/([a-f0-9]{2})\/([a-f0-9]{64})\.[a-z0-9]+$/.exec(relativePath);
  if (!match || match[1] !== match[2]!.slice(0, 2) || match[2] !== expectedHash) {
    throw new Error("BACKUP_UNSAFE_MEDIA_PATH");
  }
  const destination = resolve(staging, logicalPath);
  if (!destination.startsWith(`${staging}${sep}`)) throw new Error("BACKUP_UNSAFE_MEDIA_PATH");
  return destination;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

type LeaseOwner = { token: string; pid: number; processStartNonce: string };

async function readLeaseOwner(pathname: string): Promise<LeaseOwner | null> {
  const stat = await lstat(pathname).catch((error) => isMissing(error) ? null : Promise.reject(error));
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  try {
    const parsed = JSON.parse(await readFile(pathname, "utf8")) as { token?: unknown; pid?: unknown; processStartNonce?: unknown };
    return typeof parsed.token === "string" && parsed.token.length > 0
      && typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
      && typeof parsed.processStartNonce === "string" && parsed.processStartNonce.length > 0
      ? { token: parsed.token, pid: parsed.pid, processStartNonce: parsed.processStartNonce }
      : null;
  } catch {
    return null;
  }
}

async function readRunMarker(pathname: string): Promise<{ token: string; startedAt: string; heartbeatAt: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(pathname, "utf8")) as Record<string, unknown>;
    if (parsed.format !== RUN_FORMAT || parsed.version !== 1 || typeof parsed.token !== "string" || typeof parsed.pid !== "number"
      || typeof parsed.startedAt !== "string" || typeof parsed.heartbeatAt !== "string") return null;
    if (Number.isNaN(Date.parse(parsed.startedAt)) || Number.isNaN(Date.parse(parsed.heartbeatAt))) return null;
    return { token: parsed.token, startedAt: parsed.startedAt, heartbeatAt: parsed.heartbeatAt };
  } catch {
    return null;
  }
}

function isStale(marker: { heartbeatAt: string }, markerMtimeMs: number, now: Date): boolean {
  return Date.parse(marker.heartbeatAt) <= now.getTime() - SNAPSHOT_LOCK_STALE_MS
    && markerMtimeMs <= now.getTime() - SNAPSHOT_LOCK_STALE_MS;
}

function asLeaseLost(error: unknown): Error {
  return error instanceof Error && error.message === "BACKUP_LEASE_LOST"
    ? error
    : new Error("BACKUP_LEASE_LOST", { cause: error });
}

function sameLeaseOwner(left: LeaseOwner | null, right: LeaseOwner): boolean {
  return left?.token === right.token && left.pid === right.pid && left.processStartNonce === right.processStartNonce;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
