import { rmSync } from "node:fs";
import { buildServer } from "./app.js";

const dataRoot = process.env.DIARY_DATA_ROOT;
if (!dataRoot) throw new Error("DIARY_DATA_ROOT is required for the E2E server.");

const host = process.env.DIARY_HOST ?? "127.0.0.1";
const port = Number(process.env.DIARY_PORT ?? "4174");
const server = buildServer({ dataRoot });
let closing = false;

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  rmSync(dataRoot!, { recursive: true, force: true });
}

server.post("/__e2e__/shutdown", async (_request, reply) => {
  await reply.send({ status: "closing" });
  setImmediate(() => {
    void close().finally(() => process.exit(0));
  });
});

process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

await server.listen({ host, port });
