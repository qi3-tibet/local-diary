import { randomUUID } from "node:crypto";
import type { DiaryDatabase } from "./db/client.js";

export function seedLargeDiaryInto(database: DiaryDatabase, count: number, days = Math.ceil(count / 4), sameMinute = false): void {
  const insertEntry = database.prepare(`INSERT INTO entries (id,title,markdown,state,published_at,created_at,updated_at,deleted_at) VALUES (?, ?, ?, 'published', ?, ?, ?, NULL)`);
  const insertSearch = database.prepare(`INSERT INTO entry_search (entry_id,title,body,tags,song_title,song_artist,song_album) VALUES (?, ?, ?, ?, '', '', '')`);
  database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const day = new Date(Date.UTC(2020, 6, 26 + (index % days))).toISOString().slice(0, 10);
      const minute = sameMinute ? 0 : Math.floor(index / days) % 60;
      const timestamp = `${day}T08:${String(minute).padStart(2, "0")}:00.000+08:00`;
      const id = randomUUID(); const title = `第 ${index + 1} 条`; const body = index % 5 === 0 ? `水滴落在窗边 ${index}` : `日常记录 ${index}`;
      insertEntry.run(id, title, body, timestamp, timestamp, timestamp); insertSearch.run(id, title, body, "performance");
    }
  })();
}
