import { randomUUID } from "node:crypto";
import { createInMemoryDiaryDatabase, type DiaryDatabase } from "../src/db/client.js";

type SeedOptions = {
  days?: number;
  sameMinute?: boolean;
};

/** A deterministic, transaction-backed test fixture. It is never registered as a route. */
export function seedLargeDiary(count: number, options: SeedOptions = {}) {
  const database = createInMemoryDiaryDatabase();
  seedLargeDiaryInto(database, count, options);
  return { database, close: () => database.close() } as { database: DiaryDatabase; close: () => void };
}

export function seedLargeDiaryInto(database: DiaryDatabase, count: number, options: SeedOptions = {}): void {
  const days = options.days ?? Math.ceil(count / 4);
  const insertEntry = database.prepare(`
    INSERT INTO entries (id, title, markdown, state, published_at, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, 'published', ?, ?, ?, NULL)
  `);
  const insertSearch = database.prepare(`
    INSERT INTO entry_search (entry_id, title, body, tags, song_title, song_artist, song_album)
    VALUES (?, ?, ?, ?, '', '', '')
  `);
  const seed = database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const dayOffset = index % days;
      const date = new Date(Date.UTC(2020, 6, 26 + dayOffset, 0, 0, 0));
      const day = date.toISOString().slice(0, 10);
      const minute = options.sameMinute ? 0 : Math.floor(index / days) % 60;
      const timestamp = `${day}T${String(8 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000+08:00`;
      const id = randomUUID();
      const title = `第 ${index + 1} 条`;
      const body = index % 5 === 0 ? `水滴落在窗边 ${index}` : `日常记录 ${index}`;
      insertEntry.run(id, title, body, timestamp, timestamp, timestamp);
      insertSearch.run(id, title, body, "performance");
    }
  });
  seed();
}
