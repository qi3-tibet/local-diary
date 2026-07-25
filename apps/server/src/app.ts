import Fastify from "fastify";

export type ServerOptions = { dataRoot?: string };

export function buildServer(_options: ServerOptions = {}) {
  const server = Fastify({ logger: false });
  server.get("/api/v1/health", async () => ({ status: "ok", apiVersion: 1 }));
  return server;
}
