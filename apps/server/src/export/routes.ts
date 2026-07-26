import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DiaryDatabase } from "../db/client.js";
import type { MediaStore } from "../media/store.js";
import {
  exportMarkdownArchive,
  validateMarkdownExportSelection,
  type MarkdownExportSelection,
} from "./markdown.js";

export function registerMarkdownExportRoutes(server: FastifyInstance, options: {
  database: () => DiaryDatabase;
  mediaStore: () => MediaStore;
  temporaryRoot: string;
}): void {
  server.get("/api/v1/exports/markdown", async (request, reply) => {
    let selection: MarkdownExportSelection;
    try {
      selection = validateMarkdownExportSelection(request.query);
    } catch {
      return reply.code(400).send({ error: "EXPORT_SELECTION_INVALID" });
    }

    const root = join(options.temporaryRoot, "markdown-exports");
    await mkdir(root, { recursive: true });
    const archive = join(root, `${randomUUID()}.zip`);
    try {
      await exportMarkdownArchive(selection, {
        database: options.database(),
        mediaStore: options.mediaStore(),
      }, archive);
      const stream = createReadStream(archive);
      const cleanup = () => { void rm(archive, { force: true }); };
      stream.once("close", cleanup);
      reply.raw.once("close", cleanup);
      reply
        .type("application/zip")
        .header("content-disposition", `attachment; filename="${downloadName(selection)}"`)
        .header("cache-control", "no-store");
      return reply.send(stream);
    } catch (error) {
      await rm(archive, { force: true });
      const message = error instanceof Error ? error.message : "EXPORT_FAILED";
      if (message === "EXPORT_ENTRY_NOT_FOUND" || message === "EXPORT_RANGE_EMPTY") {
        return reply.code(404).send({ error: message });
      }
      if (message.startsWith("EXPORT_MEDIA_") || message === "EXPORT_ENTRY_INVALID") {
        return reply.code(422).send({ error: message });
      }
      throw error;
    }
  });
}

function downloadName(selection: MarkdownExportSelection): string {
  if ("entryId" in selection) return `diary-entry-${selection.entryId}.zip`;
  return `diary-${selection.from}-to-${selection.to}.zip`;
}
