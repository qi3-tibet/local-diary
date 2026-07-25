import { draftInputSchema } from "@diary/contracts";
import type { FastifyInstance } from "fastify";
import { EntryService, EntryValidationError } from "./service.js";

export async function registerEntryRoutes(server: FastifyInstance, service: EntryService): Promise<void> {
  server.get("/api/v1/draft", async (_request, reply) => reply.send(service.getDraft() ?? null));
  server.put("/api/v1/draft", async (request, reply) =>
    reply.send(service.saveDraft(draftInputSchema.parse(request.body))),
  );
  server.post("/api/v1/draft/publish", async (_request, reply) => {
    try {
      return reply.code(201).send(service.publishDraft());
    } catch (error) {
      if (error instanceof EntryValidationError) {
        return reply.code(422).send({ fields: error.fields });
      }
      throw error;
    }
  });
  server.get("/api/v1/entries", async () => service.listPublished());
}
