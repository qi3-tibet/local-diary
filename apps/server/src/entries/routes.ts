import { draftInputSchema } from "@diary/contracts";
import type { FastifyInstance } from "fastify";
import { EntryRepository } from "./repository.js";
import { EntryService, EntryValidationError } from "./service.js";

export async function registerEntryRoutes(
  server: FastifyInstance,
  service: EntryService,
  entries: EntryRepository,
): Promise<void> {
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
  server.patch<{ Params: { id: string } }>("/api/v1/entries/:id", async (request, reply) => {
    const entry = entries.updatePublished(request.params.id, draftInputSchema.parse(request.body));
    return entry ? reply.send(entry) : reply.code(404).send();
  });
  server.delete<{ Params: { id: string } }>("/api/v1/entries/:id", async (request, reply) => {
    const entry = entries.trashPublished(request.params.id);
    return entry ? reply.code(204).send() : reply.code(404).send();
  });
  server.get("/api/v1/trash", async () => ({ items: entries.listTrashed() }));
  server.post<{ Params: { id: string } }>("/api/v1/trash/:id/restore", async (request, reply) => {
    const entry = entries.restoreTrashed(request.params.id);
    return entry ? reply.send(entry) : reply.code(404).send();
  });
}
