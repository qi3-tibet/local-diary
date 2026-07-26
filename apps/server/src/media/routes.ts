import type { FastifyInstance } from "fastify";
import { ImageEntryNotFoundError, ImageService } from "./images.js";

export async function registerMediaRoutes(
  server: FastifyInstance,
  images: ImageService,
): Promise<void> {
  server.post<{ Params: { id: string } }>("/api/v1/entries/:id/images", async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "An image file is required" });
    if (!file.mimetype.startsWith("image/")) {
      file.file.resume();
      return reply.code(415).send({ error: "Only image uploads are supported" });
    }

    try {
      const image = await images.ingest(request.params.id, file.file, file.mimetype);
      return reply.code(201).send({
        mediaId: image.mediaId,
        markdownUrl: `media:${image.mediaId}`,
        alt: file.filename || "image",
        derivativeStatus: image.derivativeStatus,
      });
    } catch (error) {
      if (error instanceof ImageEntryNotFoundError) return reply.code(404).send();
      throw error;
    }
  });
}
