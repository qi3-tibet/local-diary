import { buildServer } from "../../../apps/server/src/app.js";
import {
  createInMemoryDiaryDatabase,
  type DiaryDatabase,
} from "../../../apps/server/src/db/client.js";

export function createTestDatabase(): DiaryDatabase {
  return createInMemoryDiaryDatabase();
}

export function buildTestServer(_options: { now?: string } = {}) {
  return buildServer();
}
