import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { createDiaryDatabase, type DiaryDatabase } from "./db/client.js";
import { EntryRepository } from "./entries/repository.js";
import { registerEntryRoutes } from "./entries/routes.js";
import { EntryService } from "./entries/service.js";
import { registerSearchRoutes } from "./search/routes.js";
import { createBeijingClock, type BeijingClock } from "./time/beijing.js";
import { ImageService } from "./media/images.js";
import { registerMediaRoutes } from "./media/routes.js";
import { MediaStore } from "./media/store.js";
import path from "node:path";

export type ServerOptions = {
  dataRoot?: string;
  database?: DiaryDatabase;
  clock?: BeijingClock;
};

export function buildServer(options: ServerOptions = {}) {
  const server = Fastify({ logger: false });
  const dataRoot = options.dataRoot ?? "data";
  const database = options.database ?? createDiaryDatabase(dataRoot);
  const entries = new EntryRepository(database);
  const service = new EntryService(
    entries,
    options.clock ?? createBeijingClock(),
  );
  const images = new ImageService(database, new MediaStore(path.join(dataRoot, "media")));

  server.get("/api/v1/health", async () => ({ status: "ok", apiVersion: 1 }));
  void server.register(multipart);
  void registerEntryRoutes(server, service, entries);
  void registerSearchRoutes(server, entries);
  void registerMediaRoutes(server, images);
  server.addHook("onClose", async () => database.close());

  return server;
}
