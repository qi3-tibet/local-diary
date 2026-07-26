import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import type { SnapshotService } from "./snapshot.js";
import { exportArchive } from "./archive.js";
import { restoreArchive, type RestoreContext } from "./restore.js";

const ARCHIVE_UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024;
const ZIP_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);

export function registerBackupRoutes(server: FastifyInstance, options: {
  snapshots: () => SnapshotService;
  temporaryRoot: string;
  restoreContext?: () => RestoreContext | null;
}): void {
  server.get("/api/v1/backups/:snapshotId/archive", async (request, reply) => {
    const snapshotId = (request.params as { snapshotId: string }).snapshotId;
    if (!/^[0-9a-f-]{36}$/.test(snapshotId)) return reply.code(404).send({ error: "BACKUP_SNAPSHOT_NOT_FOUND" });
    const root = join(options.temporaryRoot, "archive-downloads");
    await mkdir(root, { recursive: true });
    const archive = join(root, `${randomUUID()}.zip`);
    try {
      await exportArchive(snapshotId, options.snapshots(), archive);
      reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="diary-${snapshotId}.zip"`);
      reply.raw.once("close", () => { void rm(archive, { force: true }); });
      return reply.send(createReadStream(archive));
    } catch (error) {
      await rm(archive, { force: true });
      throw error;
    }
  });

  server.post("/api/v1/backups/restore", async (request, reply) => {
    const context = options.restoreContext?.();
    if (!context) return reply.code(409).send({ error: "RESTORE_CONTEXT_REQUIRED" });
    const upload = await request.file({ limits: { files: 1, fileSize: ARCHIVE_UPLOAD_LIMIT } });
    if (
      !upload
      || !upload.filename.toLowerCase().endsWith(".zip")
      || !ZIP_MIME_TYPES.has(upload.mimetype.toLowerCase())
    ) {
      return reply.code(400).send({ error: "ARCHIVE_REQUIRED" });
    }
    const root = join(options.temporaryRoot, "restore-uploads");
    await mkdir(root, { recursive: true });
    const archive = join(root, `${randomUUID()}.zip`);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
    const events = new PassThrough(); events.pipe(reply.raw);
    const emit = (value: Record<string, string>) => events.write(`${JSON.stringify(value)}\n`);
    try {
      await pipeline(upload.file, (await import("node:fs")).createWriteStream(archive, { flags: "wx" }));
      if (upload.file.truncated) {
        emit({ phase: "FAILED", error: "ARCHIVE_SIZE_LIMIT" });
        return events.end();
      }
      await restoreArchive(archive, { ...context, onProgress: (phase) => emit({ phase }) });
    } catch (error) {
      emit({
        phase: "FAILED",
        error: error instanceof Error ? error.message : "RESTORE_FAILED",
      });
    }
    finally { await rm(archive, { force: true }); events.end(); }
  });
}
