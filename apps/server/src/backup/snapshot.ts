import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { snapshotManifestSchema, type SnapshotManifest } from "@diary/contracts";
import type { DiaryDatabase } from "../db/client.js";
import { BackupObjectStore } from "./object-store.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA_FILE = /^[a-f0-9]{64}\.[a-z0-9]+$/;
const INTERRUPTED_MANIFEST = /^[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/;
const INTERRUPTED_MEDIA = /^[a-f0-9]{64}\.[a-z0-9]+\.[0-9a-f-]{36}\.tmp$/;

export type SnapshotInfo = SnapshotManifest & { objects: string[] };

export type SnapshotServiceOptions = {
  dataRoot: string;
  backupRoot: string;
  database: DiaryDatabase;
};

export class SnapshotService {
  private static readonly locks = new Map<string, Promise<void>>();
  private readonly dataRoot: string;
  private readonly backupRoot: string;
  private readonly manifestsRoot: string;
  private readonly database: DiaryDatabase;
  readonly objects: BackupObjectStore;

  constructor(options: SnapshotServiceOptions) {
    this.dataRoot = resolve(options.dataRoot);
    this.backupRoot = resolve(options.backupRoot);
    this.manifestsRoot = join(this.backupRoot, "manifests");
    this.database = options.database;
    this.objects = new BackupObjectStore(this.backupRoot);
  }

  async create(day: string): Promise<SnapshotInfo> {
    if (!DAY.test(day)) throw new Error("Invalid Beijing backup day");
    const observed = await this.findByDay(day);
    return this.withLock(async () => {
      await this.cleanupInterruptedArtifacts();
      await this.collectUnreferencedObjects();
      const current = await this.findByDay(day);
      if (observed && current && current.id !== observed.id) return asInfo(current);

      const databaseObject = await this.backupDatabase();
      const mediaObjects = await this.inventoryMedia();
      const manifest = snapshotManifestSchema.parse({
        format: "local-diary-snapshot",
        version: 1,
        id: randomUUID(),
        day,
        createdAt: new Date().toISOString(),
        databaseObject,
        mediaObjects,
      });

      await this.writeManifest(manifest);
      if (current) await rm(this.manifestPath(current.id), { force: true });
      await this.prune();
      return asInfo(manifest);
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

  private async backupDatabase(): Promise<string> {
    const temporaryRoot = join(this.backupRoot, ".tmp");
    await mkdir(temporaryRoot, { recursive: true });
    const destination = join(temporaryRoot, `${randomUUID()}.sqlite`);
    try {
      await this.database.backup(destination);
      return await this.objects.put(await readFile(destination));
    } finally {
      await rm(destination, { force: true });
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

  private async writeManifest(manifest: SnapshotManifest): Promise<void> {
    await mkdir(this.manifestsRoot, { recursive: true });
    const destination = this.manifestPath(manifest.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { flag: "wx" });
    await rename(temporary, destination);
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

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const key = this.backupRoot;
    const previous = SnapshotService.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    SnapshotService.locks.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (SnapshotService.locks.get(key) === tail) SnapshotService.locks.delete(key);
    }
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
