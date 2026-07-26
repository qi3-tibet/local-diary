import type { FastifyInstance } from "fastify";
import { MusicAlreadyAttachedError, MusicEntryNotFoundError, MusicService, MusicValidationError } from "./service.js";

export async function registerMusicRoutes(server: FastifyInstance, music: MusicService): Promise<void> {
  const attach = async (request: { params: { id: string }; file: () => Promise<{ file: NodeJS.ReadableStream; mimetype: string } | undefined> }, reply: { code: (status: number) => { send: (payload?: unknown) => unknown } }) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "An MP3 file is required" });
    if (file.mimetype.trim().toLowerCase() !== "audio/mpeg") {
      file.file.resume();
      return reply.code(415).send({ error: "Unsupported audio MIME type" });
    }
    try {
      const bytes = await readStream(file.file);
      const attached = await music.attach(request.params.id, bytes);
      return reply.code(201).send(toResponse(attached));
    } catch (error) {
      if (error instanceof MusicEntryNotFoundError) return reply.code(404).send();
      if (error instanceof MusicAlreadyAttachedError) return reply.code(409).send({ error: error.message });
      if (error instanceof MusicValidationError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  };
  server.post<{ Params: { id: string } }>("/api/v1/entries/:id/music", attach);
  server.patch<{ Params: { id: string } }>("/api/v1/entries/:id/music", attach);
}

function toResponse(attached: Awaited<ReturnType<MusicService["attach"]>>) {
  return {
    mediaId: attached.mediaId,
    title: attached.title,
    artist: attached.artist,
    album: attached.album,
    year: attached.year,
    coverMediaId: attached.coverMediaId,
    coverMime: attached.coverMime,
    recognitionStatus: attached.recognitionStatus,
  };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
