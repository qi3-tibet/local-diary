import type { FastifyInstance } from "fastify";
import { EntryRepository } from "../entries/repository.js";

export async function registerSearchRoutes(server: FastifyInstance, entries: EntryRepository): Promise<void> {
  server.get<{ Querystring: { q?: string } }>("/api/v1/search", async (request) => ({
    items: entries.searchPublished(request.query.q ?? ""),
  }));
}
