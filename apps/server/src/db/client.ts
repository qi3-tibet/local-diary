import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type DiaryDatabase = Database.Database;

const migration001 = `
  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    markdown TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('draft','published','trashed')),
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE UNIQUE INDEX one_draft_only ON entries(state) WHERE state = 'draft';
  CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
  CREATE TABLE entry_tags (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY(entry_id, tag_id)
  );
`;

const migration002 = `
  CREATE VIRTUAL TABLE entry_search USING fts5(
    entry_id UNINDEXED,
    title,
    body,
    tags,
    song_title,
    song_artist,
    song_album,
    tokenize = 'trigram'
  );
`;

const migration003 = `
  ALTER TABLE entries ADD COLUMN edited_at TEXT;
`;

export function migrateDiaryDatabase(db: DiaryDatabase): void {
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version < 1) {
    db.transaction(() => {
      db.exec(migration001);
      db.pragma("user_version = 1");
    })();
  }

  if (version < 2) {
    db.transaction(() => {
      db.exec(migration002);
      db.exec(`
        INSERT INTO entry_search (entry_id, title, body, tags, song_title, song_artist, song_album)
        SELECT entries.id, entries.title, entries.markdown,
          COALESCE(group_concat(tags.name, ' '), ''), '', '', ''
        FROM entries
        LEFT JOIN entry_tags ON entry_tags.entry_id = entries.id
        LEFT JOIN tags ON tags.id = entry_tags.tag_id
        GROUP BY entries.id
      `);
      db.pragma("user_version = 2");
    })();
  }

  if (version < 3) {
    db.transaction(() => {
      db.exec(migration003);
      db.pragma("user_version = 3");
    })();
  }
}

export function createInMemoryDiaryDatabase(): DiaryDatabase {
  const db = new Database(":memory:");
  migrateDiaryDatabase(db);
  return db;
}

export function createDiaryDatabase(dataRoot: string): DiaryDatabase {
  mkdirSync(dataRoot, { recursive: true });
  const db = new Database(path.join(dataRoot, "diary.sqlite"));
  migrateDiaryDatabase(db);
  return db;
}
