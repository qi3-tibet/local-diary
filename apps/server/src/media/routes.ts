import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { ImageEntryNotFoundError, ImageService, ImageValidationError, isSupportedImageMime } from "./images.js";

export async function registerMediaRoutes(
  server: FastifyInstance,
  images: () => ImageService,
): Promise<void> {
  server.post<{ Params: { id: string } }>("/api/v1/entries/:id/images", async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "An image file is required" });
    if (!isSupportedImageMime(file.mimetype)) {
      file.file.resume();
      return reply.code(415).send({ error: "Unsupported image MIME type" });
    }

    try {
      const image = await images().ingest(request.params.id, file.file, file.mimetype);
      return reply.code(201).send({
        mediaId: image.mediaId,
        markdownUrl: `media:${image.mediaId}`,
        alt: file.filename || "image",
        derivativeStatus: image.derivativeStatus,
      });
    } catch (error) {
      if (error instanceof ImageEntryNotFoundError) return reply.code(404).send();
      if (error instanceof ImageValidationError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  server.get<{ Params: { id: string } }>("/api/v1/media/:id/display", async (request, reply) => {
    const image = images().findDisplay(request.params.id);
    if (!image) return reply.code(404).send();
    return reply.type(image.mime).send(createReadStream(image.path));
  });
}
