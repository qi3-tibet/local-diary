import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const HASH = /^[a-f0-9]{64}$/;
const INTERRUPTED_OBJECT = /^[a-f0-9]{64}\.[0-9a-f-]{36}\.tmp$/;

export class BackupObjectStore {
  private static readonly locks = new Map<string, Promise<void>>();
  private readonly root: string;
  private readonly objectsRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.objectsRoot = join(this.root, "objects");
  }

  async put(bytes: Buffer): Promise<string> {
    const hash = createHash("sha256").update(bytes).digest("hex");
    return this.withLock(hash, async () => {
      const target = this.pathFor(hash);
      await this.assertSafeParent(target);
      const existing = await lstat(target).catch((error) => isMissing(error) ? null : Promise.reject(error));
      if (existing) {
        await this.verify(hash);
        return hash;
      }

      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { flag: "wx" });
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        await rm(temporary, { force: true });
      }
      await this.verify(hash);
      return hash;
    });
  }

  pathFor(hash: string): string {
    assertHash(hash);
    return join(this.objectsRoot, hash.slice(0, 2), hash);
  }

  async readVerified(hash: string): Promise<Buffer> {
    assertHash(hash);
    const file = this.pathFor(hash);
    await this.assertObjectPath(file);
    const stat = await lstat(file).catch((error) => {
      if (isMissing(error)) throw new Error("BACKUP_OBJECT_MISSING");
      throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
    const bytes = await readFile(file);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) {
      throw new Error("BACKUP_OBJECT_CHECKSUM_MISMATCH");
    }
    return bytes;
  }

  async verify(hash: string): Promise<void> {
    await this.readVerified(hash);
  }

  async count(): Promise<number> {
    const root = await lstat(this.objectsRoot).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!root) return 0;
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
    let count = 0;
    for (const prefix of await readdir(this.objectsRoot, { withFileTypes: true })) {
      if (!prefix.isDirectory() || prefix.isSymbolicLink()) throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
      for (const object of await readdir(join(this.objectsRoot, prefix.name), { withFileTypes: true })) {
        if (object.isFile() && INTERRUPTED_OBJECT.test(object.name)) continue;
        if (!object.isFile() || object.isSymbolicLink() || !HASH.test(object.name)) throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
        count += 1;
      }
    }
    return count;
  }

  async remove(hash: string): Promise<void> {
    assertHash(hash);
    await rm(this.pathFor(hash), { force: true });
  }

  async allHashes(): Promise<string[]> {
    const root = await lstat(this.objectsRoot).catch((error) => isMissing(error) ? null : Promise.reject(error));
    if (!root) return [];
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
    const hashes: string[] = [];
    for (const prefix of await readdir(this.objectsRoot, { withFileTypes: true })) {
      if (!prefix.isDirectory() || prefix.isSymbolicLink()) throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
      for (const object of await readdir(join(this.objectsRoot, prefix.name), { withFileTypes: true })) {
        if (object.isFile() && INTERRUPTED_OBJECT.test(object.name)) continue;
        if (!object.isFile() || object.isSymbolicLink() || !HASH.test(object.name)) throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
        hashes.push(object.name);
      }
    }
    return hashes;
  }

  async cleanupInterruptedObjects(): Promise<void> {
    const root = await lstat(this.objectsRoot).catch((error) => isMissing(error) ? null : Promise.reject(error));
    if (!root) return;
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
    for (const prefix of await readdir(this.objectsRoot, { withFileTypes: true })) {
      if (!prefix.isDirectory() || prefix.isSymbolicLink()) throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
      const parent = join(this.objectsRoot, prefix.name);
      for (const object of await readdir(parent, { withFileTypes: true })) {
        if (object.isFile() && INTERRUPTED_OBJECT.test(object.name)) await rm(join(parent, object.name), { force: true });
      }
    }
  }

  private async assertSafeParent(target: string): Promise<void> {
    if (!target.startsWith(`${this.objectsRoot}\\`) && !target.startsWith(`${this.objectsRoot}/`)) {
      throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
    }
    await mkdir(this.objectsRoot, { recursive: true });
    const objects = await lstat(this.objectsRoot);
    if (!objects.isDirectory() || objects.isSymbolicLink()) throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
    await mkdir(dirname(target), { recursive: true });
    const parent = await lstat(dirname(target));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
  }

  private async assertObjectPath(target: string): Promise<void> {
    const objects = await lstat(this.objectsRoot).catch((error) => {
      if (isMissing(error)) throw new Error("BACKUP_OBJECT_MISSING");
      throw error;
    });
    const parent = await lstat(dirname(target)).catch((error) => {
      if (isMissing(error)) throw new Error("BACKUP_OBJECT_MISSING");
      throw error;
    });
    if (!objects.isDirectory() || objects.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error("BACKUP_OBJECT_UNSAFE_PATH");
    }
  }

  private async withLock<T>(hash: string, work: () => Promise<T>): Promise<T> {
    const key = `${this.root}:${hash}`;
    const previous = BackupObjectStore.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    BackupObjectStore.locks.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (BackupObjectStore.locks.get(key) === tail) BackupObjectStore.locks.delete(key);
    }
  }
}

function assertHash(hash: string): void {
  if (!HASH.test(hash)) throw new Error("Invalid backup object hash");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
