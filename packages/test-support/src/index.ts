import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../../../apps/server/src/app.js";
import {
  createInMemoryDiaryDatabase,
  type DiaryDatabase,
} from "../../../apps/server/src/db/client.js";
import { createBeijingClock } from "../../../apps/server/src/time/beijing.js";

export function createTestDatabase(): DiaryDatabase {
  return createInMemoryDiaryDatabase();
}

export function buildTestServer(options: { now?: string } = {}) {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-test-"));
  const server = buildServer({
    dataRoot,
    clock: createBeijingClock(() => new Date(options.now ?? "2026-07-26T00:00:00.000Z")),
  });
  const close = server.close.bind(server);
  server.close = ((closeListener?: () => void) => {
    if (closeListener) {
      return close(() => {
        rmSync(dataRoot, { recursive: true, force: true });
        closeListener();
      });
    }
    return close().then(() => rmSync(dataRoot, { recursive: true, force: true }));
  }) as typeof server.close;
  return server;
}
