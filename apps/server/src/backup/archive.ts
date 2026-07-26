import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import CRC32 from "crc-32";
import yauzl from "yauzl";
import yazl from "yazl";
import { snapshotManifestSchema, type SnapshotManifest } from "@diary/contracts";
import type { SnapshotService } from "./snapshot.js";

const HASH = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 1_000_002;
const MAX_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");

export type ExtractedArchive = { manifest: SnapshotManifest; objectsRoot: string };

export async function exportArchive(snapshotId: string, snapshots: SnapshotService, output: string): Promise<void> {
  const manifest = (await snapshots.list()).find((snapshot) => snapshot.id === snapshotId);
  if (!manifest) throw new Error("BACKUP_SNAPSHOT_NOT_FOUND");
  const target = resolve(output);
  if (await lstat(target).catch(missing)) throw new Error("ARCHIVE_OUTPUT_EXISTS");
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const zip = new yazl.ZipFile();
  try {
    zip.addBuffer(Buffer.from(`${JSON.stringify(stripInfo(manifest))}\n`), "manifest.json", { compress: false, mtime: ZIP_EPOCH, mode: 0o100600 });
    for (const hash of objectHashes(manifest)) {
      await snapshots.objects.verify(hash);
      zip.addFile(snapshots.objects.pathFor(hash), `objects/${hash}`, { compress: false, mtime: ZIP_EPOCH, mode: 0o100600 });
    }
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(temporary, { flags: "wx" }));
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Extracts only verified archive contents to an owned directory. Nothing is held in memory except the small manifest. */
export async function extractAndValidateArchive(archivePath: string, stagingRoot: string): Promise<ExtractedArchive> {
  const root = resolve(stagingRoot);
  await mkdir(root, { recursive: true });
  const archive = await openZip(resolve(archivePath));
  try {
    let manifest: SnapshotManifest | null = null;
    let expected: Set<string> | null = null;
    let total = 0; let count = 0;
    await new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
      archive.on("error", fail);
      archive.on("end", () => { if (!settled) { settled = true; resolvePromise(); } });
      archive.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          try {
            const name = safeEntryName(entry.fileName);
            if (count++ === 0 && name !== "manifest.json") throw new Error("ARCHIVE_MANIFEST_NOT_FIRST");
            if (entry.uncompressedSize > (name === "manifest.json" ? MAX_MANIFEST_BYTES : MAX_OBJECT_BYTES)
              || (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200)) throw new Error("ARCHIVE_SIZE_LIMIT");
            if ((entry.externalFileAttributes >>> 16) !== 0 && !isRegular(entry)) throw new Error("ARCHIVE_SPECIAL_ENTRY");
            total += entry.uncompressedSize;
            if (count > MAX_ENTRIES || total > MAX_TOTAL_BYTES) throw new Error("ARCHIVE_SIZE_LIMIT");
            if (name === "manifest.json") {
              const bytes = await readSmallEntry(archive, entry, MAX_MANIFEST_BYTES);
              try { manifest = snapshotManifestSchema.parse(JSON.parse(bytes.toString("utf8"))); }
              catch { throw new Error("ARCHIVE_MANIFEST_INVALID"); }
              expected = new Set(["manifest.json", ...objectHashes(manifest).map((hash) => `objects/${hash}`)]);
              expected.delete("manifest.json");
            } else {
              if (!manifest || !expected || !expected.delete(name)) throw new Error("ARCHIVE_UNEXPECTED_ENTRY");
              await extractObject(archive, entry, join(root, name));
            }
            archive.readEntry();
          } catch (error) { fail(error as Error); }
        })();
      });
      archive.readEntry();
    });
    const finalManifest = manifest as SnapshotManifest | null;
    const finalExpected = expected as Set<string> | null;
    if (!finalManifest || !finalExpected || finalExpected.size !== 0) throw new Error("ARCHIVE_UNEXPECTED_ENTRY");
    return { manifest: finalManifest, objectsRoot: join(root, "objects") };
  } finally { archive.close(); }
}

export async function validateArchive(archivePath: string): Promise<SnapshotManifest> {
  const root = join(dirname(resolve(archivePath)), `.archive-validate-${randomUUID()}`);
  try { return (await extractAndValidateArchive(archivePath, root)).manifest; }
  finally { await rm(root, { recursive: true, force: true }); }
}

function stripInfo(manifest: SnapshotManifest & { objects?: string[] }): SnapshotManifest { const { objects: _objects, ...plain } = manifest; return plain; }
export function objectHashes(manifest: SnapshotManifest): string[] { const hashes = [manifest.databaseObject, ...manifest.mediaObjects.map((item) => item.hash)]; if (hashes.some((hash) => !HASH.test(hash))) throw new Error("ARCHIVE_MANIFEST_INVALID"); return [...new Set(hashes)].sort(); }
function safeEntryName(name: string): string { if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || name.startsWith("//") || /^[A-Za-z]:/.test(name) || name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("ARCHIVE_UNSAFE_PATH"); return name; }
function isRegular(entry: yauzl.Entry): boolean { const mode = (entry.externalFileAttributes >>> 16) & 0xf000; return mode === 0 || mode === 0x8000; }
function openZip(pathname: string): Promise<yauzl.ZipFile> { return new Promise((resolvePromise, reject) => yauzl.open(pathname, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true, strictFileNames: true }, (error, zip) => error || !zip ? reject(error ?? new Error("ARCHIVE_INVALID")) : resolvePromise(zip))); }
function readSmallEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, max: number): Promise<Buffer> { return new Promise((resolvePromise, reject) => zip.openReadStream(entry, (error, stream) => { if (error || !stream) return reject(error ?? new Error("ARCHIVE_INVALID")); const chunks: Buffer[] = []; let bytes = 0; let crc = 0; stream.on("data", (chunk: Buffer) => { bytes += chunk.length; crc = CRC32.buf(chunk, crc); if (bytes > max) stream.destroy(new Error("ARCHIVE_SIZE_LIMIT")); else chunks.push(chunk); }); stream.on("error", reject); stream.on("end", () => (crc >>> 0) === entry.crc32 ? resolvePromise(Buffer.concat(chunks)) : reject(new Error("ARCHIVE_CRC_MISMATCH"))); })); }
function extractObject(zip: yauzl.ZipFile, entry: yauzl.Entry, output: string): Promise<void> { return new Promise((resolvePromise, reject) => zip.openReadStream(entry, (error, stream) => { if (error || !stream) return reject(error ?? new Error("ARCHIVE_INVALID")); void mkdir(dirname(output), { recursive: true }).then(() => { const target = createWriteStream(output, { flags: "wx" }); const hash = createHash("sha256"); let bytes = 0; let crc = 0; stream.on("data", (chunk: Buffer) => { bytes += chunk.length; crc = CRC32.buf(chunk, crc); hash.update(chunk); if (bytes > MAX_OBJECT_BYTES) stream.destroy(new Error("ARCHIVE_SIZE_LIMIT")); }); stream.on("error", reject); target.on("error", reject); target.on("finish", () => { const expected = basename(output); if ((crc >>> 0) !== entry.crc32) reject(new Error("ARCHIVE_CRC_MISMATCH")); else if (hash.digest("hex") !== expected) reject(new Error("ARCHIVE_CHECKSUM_MISMATCH")); else resolvePromise(); }); stream.pipe(target); }, reject); })); }
function missing(error: unknown): null { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
