import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

export type StoredMedia = {
  hash: string;
  path: string;
};

export class MediaStore {
  constructor(private readonly root: string) {}

  async put(input: Buffer | Readable, extension: string): Promise<StoredMedia> {
    const bytes = Buffer.isBuffer(input) ? input : await this.read(input);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const target = this.pathFor(hash, extension);
    await mkdir(dirname(target), { recursive: true });

    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      await rename(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await rm(temporary, { force: true });
    }

    return { hash, path: target };
  }

  pathFor(hash: string, extension: string): string {
    return join(this.root, "objects", hash.slice(0, 2), `${hash}.${extension}`);
  }

  private async read(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}
