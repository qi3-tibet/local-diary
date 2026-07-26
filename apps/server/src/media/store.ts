import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

export type StoredMedia = {
  hash: string;
  path: string;
  created: boolean;
};

export class MediaStore {
  private static readonly objectLocks = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async put(input: Buffer | Readable, extension: string): Promise<StoredMedia> {
    const normalizedExtension = normalizeExtension(extension);
    const bytes = Buffer.isBuffer(input) ? input : await this.read(input);
    const hash = this.hash(bytes);
    const target = this.pathFor(hash, normalizedExtension);
    await mkdir(dirname(target), { recursive: true });

    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx" });
    let created = false;
    try {
      await link(temporary, target);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await rm(temporary, { force: true });
    }

    return { hash, path: target, created };
  }

  hash(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  async withObjectLocks<T>(hashes: string[], work: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    for (const hash of [...new Set(hashes)].sort()) {
      releases.push(await this.acquireObjectLock(hash));
    }
    try {
      return await work();
    } finally {
      releases.reverse().forEach((release) => release());
    }
  }

  pathFor(hash: string, extension: string): string {
    return join(this.root, "objects", hash.slice(0, 2), `${hash}.${normalizeExtension(extension)}`);
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  private async read(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  private async acquireObjectLock(hash: string): Promise<() => void> {
    const key = `${this.root}:${hash}`;
    const previous = MediaStore.objectLocks.get(key) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => { resolveCurrent = resolve; });
    const tail = previous.then(() => current);
    MediaStore.objectLocks.set(key, tail);
    await previous;
    return () => {
      resolveCurrent();
      if (MediaStore.objectLocks.get(key) === tail) MediaStore.objectLocks.delete(key);
    };
  }
}

function normalizeExtension(extension: string): string {
  if (!/^[a-z0-9]+$/.test(extension)) throw new Error("Invalid media extension");
  return extension;
}
