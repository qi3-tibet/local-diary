import Fastify from "fastify";
import { createDiaryDatabase, type DiaryDatabase } from "./db/client.js";
import { EntryRepository } from "./entries/repository.js";
import { registerEntryRoutes } from "./entries/routes.js";
import { EntryService } from "./entries/service.js";
import { createBeijingClock, type BeijingClock } from "./time/beijing.js";

export type ServerOptions = {
  dataRoot?: string;
  database?: DiaryDatabase;
  clock?: BeijingClock;
};

export function buildServer(options: ServerOptions = {}) {
  const server = Fastify({ logger: false });
  const database = options.database ?? createDiaryDatabase(options.dataRoot ?? "data");
  const service = new EntryService(
    new EntryRepository(database),
    options.clock ?? createBeijingClock(),
  );

  server.get("/api/v1/health", async () => ({ status: "ok", apiVersion: 1 }));
  void registerEntryRoutes(server, service);
  server.addHook("onClose", async () => database.close());

  return server;
}
