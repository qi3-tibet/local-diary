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
  constructor(private readonly root: string) {}

  async put(input: Buffer | Readable, extension: string): Promise<StoredMedia> {
    const normalizedExtension = normalizeExtension(extension);
    const bytes = Buffer.isBuffer(input) ? input : await this.read(input);
    const hash = createHash("sha256").update(bytes).digest("hex");
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
}

function normalizeExtension(extension: string): string {
  if (!/^[a-z0-9]+$/.test(extension)) throw new Error("Invalid media extension");
  return extension;
}
