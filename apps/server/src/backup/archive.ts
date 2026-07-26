import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";
import { snapshotManifestSchema, type SnapshotManifest } from "@diary/contracts";
import type { SnapshotService } from "./snapshot.js";

const HASH = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 1_000_002;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export type ValidatedArchive = { manifest: SnapshotManifest; objects: Map<string, Buffer> };

export async function exportArchive(snapshotId: string, snapshots: SnapshotService, output: string): Promise<void> {
  const manifest = (await snapshots.list()).find((snapshot) => snapshot.id === snapshotId);
  if (!manifest) throw new Error("BACKUP_SNAPSHOT_NOT_FOUND");
  const target = resolve(output);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await rm(temporary, { force: true });
  const zip = new yazl.ZipFile();
  try {
    zip.addBuffer(Buffer.from(`${JSON.stringify(stripInfo(manifest))}\n`), "manifest.json", { compress: true });
    for (const hash of objectHashes(manifest)) {
      const bytes = await snapshots.objects.readVerified(hash);
      zip.addBuffer(bytes, `objects/${hash}`, { compress: false });
    }
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(temporary, { flags: "wx" }));
    await renameAtomic(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function validateArchive(archivePath: string): Promise<ValidatedArchive> {
  const archive = await openZip(resolve(archivePath));
  try {
    const entries = await readZipEntries(archive);
    const manifestBytes = entries.get("manifest.json");
    if (!manifestBytes || manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("ARCHIVE_MANIFEST_INVALID");
    let manifest: SnapshotManifest;
    try { manifest = snapshotManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8"))); }
    catch { throw new Error("ARCHIVE_MANIFEST_INVALID"); }
    const hashes = objectHashes(manifest);
    const expected = new Set(["manifest.json", ...hashes.map((hash) => `objects/${hash}`)]);
    if (entries.size !== expected.size || [...entries.keys()].some((name) => !expected.has(name))) throw new Error("ARCHIVE_UNEXPECTED_ENTRY");
    const objects = new Map<string, Buffer>();
    for (const hash of hashes) {
      const bytes = entries.get(`objects/${hash}`)!;
      if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("ARCHIVE_CHECKSUM_MISMATCH");
      objects.set(hash, bytes);
    }
    return { manifest, objects };
  } finally { archive.close(); }
}

function stripInfo(manifest: SnapshotManifest & { objects?: string[] }): SnapshotManifest {
  const { objects: _objects, ...plain } = manifest;
  return plain;
}

export function objectHashes(manifest: SnapshotManifest): string[] {
  const hashes = [manifest.databaseObject, ...manifest.mediaObjects.map((item) => item.hash)];
  if (hashes.some((hash) => !HASH.test(hash))) throw new Error("ARCHIVE_MANIFEST_INVALID");
  return [...new Set(hashes)].sort();
}

function safeEntryName(name: string): string {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || name.startsWith("//")
    || /^[A-Za-z]:/.test(name) || name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("ARCHIVE_UNSAFE_PATH");
  return name;
}

function isSymlink(entry: yauzl.Entry): boolean { return ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000; }

function openZip(pathname: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, reject) => yauzl.open(pathname, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => error || !zip ? reject(error ?? new Error("ARCHIVE_INVALID")) : resolvePromise(zip)));
}

function readZipEntries(zip: yauzl.ZipFile): Promise<Map<string, Buffer>> {
  return new Promise((resolvePromise, reject) => {
    const entries = new Map<string, Buffer>(); let total = 0; let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    zip.on("error", fail);
    zip.on("end", () => { if (!settled) { settled = true; resolvePromise(entries); } });
    zip.on("entry", (entry: yauzl.Entry) => {
      try {
        const name = safeEntryName(entry.fileName);
        if (entries.has(name)) throw new Error("ARCHIVE_DUPLICATE_ENTRY");
        if (entry.uncompressedSize > MAX_ENTRY_BYTES || (entry.compressedSize === 0 && entry.uncompressedSize > 0)
          || (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200)) throw new Error("ARCHIVE_SIZE_LIMIT");
        total += entry.uncompressedSize;
        if (entries.size >= MAX_ENTRIES || total > MAX_TOTAL_BYTES) throw new Error("ARCHIVE_SIZE_LIMIT");
        if (isSymlink(entry)) throw new Error("ARCHIVE_SPECIAL_ENTRY");
        readEntry(zip, entry, MAX_ENTRY_BYTES).then((bytes) => { entries.set(name, bytes); zip.readEntry(); }, fail);
      } catch (error) { fail(error as Error); }
    });
    zip.readEntry();
  });
}

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, max: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) return reject(error ?? new Error("ARCHIVE_INVALID"));
    const chunks: Buffer[] = []; let bytes = 0;
    stream.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > max) stream.destroy(new Error("ARCHIVE_SIZE_LIMIT")); else chunks.push(chunk); });
    stream.on("error", reject); stream.on("end", () => resolvePromise(Buffer.concat(chunks)));
  }));
}

async function renameAtomic(from: string, to: string): Promise<void> {
  const { rename } = await import("node:fs/promises");
  await rename(from, to);
}
