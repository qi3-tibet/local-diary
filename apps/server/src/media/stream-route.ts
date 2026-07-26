import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DiaryDatabase } from "../db/client.js";
import { MediaStore } from "./store.js";

type MusicObject = {
  original_hash: string;
  original_mime: string;
  original_extension: string;
};

type ByteRange = { start: number; end: number };

export async function registerMusicStreamRoute(
  server: FastifyInstance,
  database: () => DiaryDatabase,
  store: () => MediaStore,
): Promise<void> {
  server.route<{ Params: { id: string } }>({
    method: ["GET", "HEAD"],
    url: "/api/v1/music/:id/stream",
    handler: async (request, reply) => {
      const object = findMusicObject(database(), request.params.id);
      if (!object) return reply.code(404).send();

      let handle: FileHandle;
      try {
        handle = await open(store().pathFor(object.original_hash, object.original_extension), "r");
      } catch {
        return unavailable(reply);
      }

      try {
        const details = await handle.stat();
        if (!details.isFile() || details.size < 4 || !(await hasMp3Header(handle))) {
          await handle.close();
          return unavailable(reply);
        }

        const range = parseRange(request.headers.range, details.size);
        if (range === "invalid") {
          await handle.close();
          return reply
            .code(416)
            .header("accept-ranges", "bytes")
            .header("content-range", `bytes */${details.size}`)
            .send();
        }

        const start = range?.start ?? 0;
        const end = range?.end ?? details.size - 1;
        const length = end - start + 1;
        reply
          .code(range ? 206 : 200)
          .type("audio/mpeg")
          .header("accept-ranges", "bytes")
          .header("content-length", String(length));
        if (range) reply.header("content-range", `bytes ${start}-${end}/${details.size}`);

        if (request.method === "HEAD") {
          await handle.close();
          return reply.send();
        }
        return reply.send(handle.createReadStream({ start, end }));
      } catch {
        await handle.close().catch(() => undefined);
        return unavailable(reply);
      }
    },
  });
}

function findMusicObject(database: DiaryDatabase, mediaId: string): MusicObject | null {
  const object = database.prepare(`
    SELECT media.original_hash, media.original_mime, media.original_extension
    FROM media
    INNER JOIN entry_music
      ON entry_music.media_id = media.id
      AND entry_music.entry_id = media.entry_id
    INNER JOIN entries ON entries.id = entry_music.entry_id
    WHERE media.id = ?
      AND media.original_mime = 'audio/mpeg'
      AND media.original_extension = 'mp3'
      AND entries.state != 'trashed'
  `).get(mediaId) as MusicObject | undefined;
  if (
    !object
    || !/^[a-f0-9]{64}$/.test(object.original_hash)
    || object.original_mime !== "audio/mpeg"
    || object.original_extension !== "mp3"
  ) return null;
  return object;
}

async function hasMp3Header(handle: FileHandle): Promise<boolean> {
  const header = Buffer.alloc(10);
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  if (bytesRead < 4) return false;
  if (header.subarray(0, 3).toString("ascii") === "ID3") return true;
  return header[0] === 0xff && (header[1] & 0xe0) === 0xe0;
}

function parseRange(header: string | undefined, size: number): ByteRange | null | "invalid" {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return "invalid";

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || requestedEnd < start
    || start >= size
  ) return "invalid";
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function unavailable(reply: {
  code(status: number): {
    send(payload?: unknown): unknown;
  };
}) {
  return reply.code(422).send({ error: "MEDIA UNAVAILABLE" });
}
