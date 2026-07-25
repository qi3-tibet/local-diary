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
  return buildServer({
    database: createTestDatabase(),
    clock: createBeijingClock(() => new Date(options.now ?? "2026-07-26T00:00:00.000Z")),
  });
}
