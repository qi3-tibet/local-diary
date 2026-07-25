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

export function migrateDiaryDatabase(db: DiaryDatabase): void {
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version >= 1) return;

  db.transaction(() => {
    db.exec(migration001);
    db.pragma("user_version = 1");
  })();
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
