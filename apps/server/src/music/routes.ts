import { musicMetadataOverrideSchema } from "@diary/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  MusicRecognitionNotFoundError,
  MusicRecognitionService,
  MusicRecognitionValidationError,
} from "./recognition/service.js";
import { MusicAlreadyAttachedError, MusicEntryNotFoundError, MusicService, MusicValidationError } from "./service.js";

export const MAX_MUSIC_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function registerMusicRoutes(
  server: FastifyInstance,
  music: () => MusicService,
  recognition: () => MusicRecognitionService,
  maxUploadBytes = MAX_MUSIC_UPLOAD_BYTES,
): Promise<void> {
  const attach = async (request: FastifyRequest<{ Params: { id: string } }>, reply: { code: (status: number) => { send: (payload?: unknown) => unknown } }) => {
    try {
      const file = await readSingleMusicFile(request, maxUploadBytes);
      const attached = await music().attach(request.params.id, file.bytes, file.filename);
      return reply.code(201).send(toResponse(attached));
    } catch (error) {
      if (error instanceof MusicEntryNotFoundError) return reply.code(404).send();
      if (error instanceof MusicAlreadyAttachedError) return reply.code(409).send({ error: error.message });
      if (error instanceof MusicValidationError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof MusicMultipartError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof server.multipartErrors.RequestFileTooLargeError) {
        return reply.code(413).send({ error: "MP3 upload exceeds the 100 MiB limit" });
      }
      if (isMultipartShapeLimitError(server, error)) return reply.code(400).send({ error: "Exactly one MP3 file is required" });
      throw error;
    }
  };
  server.post<{ Params: { id: string } }>("/api/v1/entries/:id/music", attach);
  server.patch<{ Params: { id: string } }>("/api/v1/entries/:id/music", attach);

  server.post<{ Params: { id: string } }>(
    "/api/v1/entries/:id/music/recognition",
    async (request, reply) => {
      try {
        return reply.send(await recognition().request(request.params.id));
      } catch (error) {
        return handleRecognitionError(error, reply);
      }
    },
  );
  server.get<{ Params: { id: string } }>(
    "/api/v1/entries/:id/music/recognition/candidates",
    async (request, reply) => {
      try {
        return reply.send({ items: recognition().listCandidates(request.params.id) });
      } catch (error) {
        return handleRecognitionError(error, reply);
      }
    },
  );
  server.post<{ Params: { id: string }; Body: { candidateId?: unknown } }>(
    "/api/v1/entries/:id/music/recognition/selection",
    async (request, reply) => {
      const candidateId = request.body?.candidateId;
      if (typeof candidateId !== "string" || !candidateId || candidateId.length > 200) {
        return reply.code(400).send({ error: "A valid candidate ID is required" });
      }
      try {
        return reply.send(recognition().selectCandidate(request.params.id, candidateId));
      } catch (error) {
        return handleRecognitionError(error, reply);
      }
    },
  );
  server.patch<{ Params: { id: string } }>(
    "/api/v1/entries/:id/music/metadata",
    async (request, reply) => {
      const patch = musicMetadataOverrideSchema.safeParse(request.body);
      if (!patch.success) return reply.code(400).send({ error: "Invalid music metadata" });
      try {
        return reply.send(recognition().patchOverrides(request.params.id, patch.data));
      } catch (error) {
        return handleRecognitionError(error, reply);
      }
    },
  );
}

class MusicMultipartError extends Error {
  constructor(message: string, readonly statusCode: 400 | 413) {
    super(message);
  }
}

async function readSingleMusicFile(request: FastifyRequest, maxUploadBytes: number) {
  let file: { mimetype: string; bytes: Buffer; filename: string } | undefined;
  for await (const part of request.parts({ limits: { files: 1, fields: 0, parts: 1, fileSize: maxUploadBytes } })) {
    if (part.type !== "file" || part.fieldname !== "music" || file) {
      if (part.type === "file") part.file.resume();
      throw new MusicMultipartError("Exactly one MP3 file is required", 400);
    }
    if (part.mimetype.trim().toLowerCase() !== "audio/mpeg") {
      part.file.resume();
      throw new MusicValidationError("Unsupported audio MIME type", 415);
    }
    const bytes = await readStream(part.file);
    if (part.file.truncated) throw new MusicMultipartError("MP3 upload exceeds the 100 MiB limit", 413);
    file = { mimetype: part.mimetype, bytes, filename: part.filename };
  }
  if (!file) throw new MusicMultipartError("An MP3 file is required", 400);
  return file;
}

function handleRecognitionError(
  error: unknown,
  reply: { code: (status: number) => { send: (payload?: unknown) => unknown } },
) {
  if (error instanceof MusicRecognitionNotFoundError) return reply.code(404).send();
  if (error instanceof MusicRecognitionValidationError) {
    return reply.code(422).send({ error: error.message });
  }
  throw error;
}

function isMultipartShapeLimitError(server: FastifyInstance, error: unknown): boolean {
  return error instanceof server.multipartErrors.FilesLimitError
    || error instanceof server.multipartErrors.FieldsLimitError
    || error instanceof server.multipartErrors.PartsLimitError;
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
    originalFilename: attached.originalFilename,
  };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
