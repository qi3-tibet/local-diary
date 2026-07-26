import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type DiaryDatabase = Database.Database;
export const CURRENT_DIARY_SCHEMA_VERSION = 11;

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

const migration004 = `
  CREATE TABLE media (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    original_hash TEXT NOT NULL,
    original_mime TEXT NOT NULL,
    original_extension TEXT NOT NULL,
    display_hash TEXT,
    thumbnail_hash TEXT,
    derivative_status TEXT NOT NULL CHECK (derivative_status IN ('pending', 'ready', 'failed')),
    derivative_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX media_entry_id ON media(entry_id);
`;

const migration005 = `
  CREATE TABLE entry_music (
    entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL UNIQUE REFERENCES media(id) ON DELETE RESTRICT,
    title TEXT,
    artist TEXT,
    album TEXT,
    year INTEGER,
    cover_media_id TEXT REFERENCES media(id) ON DELETE RESTRICT,
    recognition_status TEXT NOT NULL,
    user_overrides_json TEXT NOT NULL DEFAULT '{}'
  );
`;

const migration006 = `
  ALTER TABLE entry_music ADD COLUMN original_filename TEXT NOT NULL DEFAULT 'track.mp3';
  ALTER TABLE entry_music ADD COLUMN recognition_candidates_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE entry_music ADD COLUMN recognition_source TEXT;
  ALTER TABLE entry_music ADD COLUMN selected_candidate_id TEXT;
`;

const migration007 = `
  ALTER TABLE entry_music ADD COLUMN recognition_revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE entry_music ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE entry_music ADD COLUMN recognition_candidates_metadata_revision INTEGER;
  UPDATE entry_music SET recognition_candidates_json = '[]';
`;

const migration008 = `
  CREATE TABLE backup_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const migration009 = `
  CREATE INDEX entries_published_day_cursor
    ON entries(state, substr(published_at, 1, 10), published_at DESC, id DESC)
    WHERE state = 'published';
`;

const migration010 = `
  CREATE INDEX entries_published_cursor
    ON entries(state, published_at DESC, id DESC)
    WHERE state = 'published';
`;

const migration011 = `
  CREATE TABLE trash_cleanup_objects (
    hash TEXT NOT NULL,
    extension TEXT NOT NULL,
    queued_at TEXT NOT NULL,
    PRIMARY KEY(hash, extension)
  );
`;

export function migrateDiaryDatabase(db: DiaryDatabase): void {
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (
    !Number.isInteger(version)
    || version < 0
    || version > CURRENT_DIARY_SCHEMA_VERSION
  ) {
    throw new Error("DIARY_SCHEMA_UNSUPPORTED");
  }
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

  if (version < 4) {
    db.transaction(() => {
      db.exec(migration004);
      db.pragma("user_version = 4");
    })();
  }

  if (version < 5) {
    db.transaction(() => {
      db.exec(migration005);
      db.pragma("user_version = 5");
    })();
  }

  if (version < 6) {
    db.transaction(() => {
      db.exec(migration006);
      db.pragma("user_version = 6");
    })();
  }

  if (version < 7) {
    db.transaction(() => {
      db.exec(migration007);
      db.pragma("user_version = 7");
    })();
  }

  if (version < 8) {
    db.transaction(() => {
      db.exec(migration008);
      db.pragma("user_version = 8");
    })();
  }

  if (version < 9) {
    db.transaction(() => {
      db.exec(migration009);
      db.pragma("user_version = 9");
    })();
  }

  if (version < 10) {
    db.transaction(() => {
      db.exec(migration010);
      db.pragma("user_version = 10");
    })();
  }

  if (version < 11) {
    db.transaction(() => {
      db.exec(migration011);
      db.pragma("user_version = 11");
    })();
  }
}

export function validateCurrentDiarySchema(db: DiaryDatabase): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version !== CURRENT_DIARY_SCHEMA_VERSION) throw new Error("DIARY_SCHEMA_INCOMPLETE");
  if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("DIARY_SCHEMA_INCOMPLETE");
  if ((db.pragma("foreign_key_check") as unknown[]).length !== 0) {
    throw new Error("DIARY_SCHEMA_INCOMPLETE");
  }

  const requiredColumns: Record<string, string[]> = {
    entries: [
      "id", "title", "markdown", "state", "published_at", "created_at",
      "updated_at", "deleted_at", "edited_at",
    ],
    tags: ["id", "name"],
    entry_tags: ["entry_id", "tag_id"],
    entry_search: [
      "entry_id", "title", "body", "tags", "song_title", "song_artist", "song_album",
    ],
    media: [
      "id", "entry_id", "original_hash", "original_mime", "original_extension",
      "display_hash", "thumbnail_hash", "derivative_status", "derivative_error",
      "created_at", "updated_at",
    ],
    entry_music: [
      "entry_id", "media_id", "title", "artist", "album", "year", "cover_media_id",
      "recognition_status", "user_overrides_json", "original_filename",
      "recognition_candidates_json", "recognition_source", "selected_candidate_id",
      "recognition_revision", "metadata_revision",
      "recognition_candidates_metadata_revision",
    ],
    backup_state: ["key", "value", "updated_at"],
    trash_cleanup_objects: ["hash", "extension", "queued_at"],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = new Set(
      (db.pragma(`table_info('${table}')`) as Array<{ name: string }>).map(({ name }) => name),
    );
    if (columns.some((column) => !actual.has(column))) {
      throw new Error("DIARY_SCHEMA_INCOMPLETE");
    }
  }

  const objects = new Map(
    (db.prepare(`
      SELECT name, type, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
    `).all() as Array<{
      name: string;
      type: string;
      tbl_name: string;
      sql: string | null;
    }>).map((object) => [object.name, object]),
  );
  const normalTables = [
    "entries",
    "tags",
    "entry_tags",
    "media",
    "entry_music",
    "backup_state",
    "trash_cleanup_objects",
  ];
  if (normalTables.some((name) => objects.get(name)?.type !== "table")) {
    throw new Error("DIARY_SCHEMA_INCOMPLETE");
  }

  const search = objects.get("entry_search");
  const searchSql = normalizeSchemaSql(search?.sql);
  if (
    search?.type !== "table"
    || searchSql !== [
      "create virtual table entry_search using fts5(",
      "entry_id unindexed,title,body,tags,song_title,song_artist,song_album,",
      "tokenize = 'trigram')",
    ].join("")
  ) {
    throw new Error("DIARY_SCHEMA_INCOMPLETE");
  }
  try {
    db.prepare(`
      SELECT entry_id FROM entry_search
      WHERE entry_search MATCH ?
      LIMIT 0
    `).all("schema-probe");
  } catch {
    throw new Error("DIARY_SCHEMA_INCOMPLETE");
  }

  const requiredIndexes: Record<string, {
    table: string;
    sql: string;
  }> = {
    one_draft_only: {
      table: "entries",
      sql: "create unique index one_draft_only on entries(state) where state = 'draft'",
    },
    media_entry_id: {
      table: "media",
      sql: "create index media_entry_id on media(entry_id)",
    },
    entries_published_day_cursor: {
      table: "entries",
      sql: [
        "create index entries_published_day_cursor ",
        "on entries(state,substr(published_at,1,10),published_at desc,id desc) ",
        "where state = 'published'",
      ].join(""),
    },
    entries_published_cursor: {
      table: "entries",
      sql: [
        "create index entries_published_cursor ",
        "on entries(state,published_at desc,id desc) ",
        "where state = 'published'",
      ].join(""),
    },
  };
  for (const [name, expected] of Object.entries(requiredIndexes)) {
    const index = objects.get(name);
    const sql = normalizeSchemaSql(index?.sql);
    if (
      index?.type !== "index"
      || index.tbl_name !== expected.table
      || sql !== normalizeSchemaSql(expected.sql)
    ) {
      throw new Error("DIARY_SCHEMA_INCOMPLETE");
    }
  }

  const requiredForeignKeys: Record<string, string[]> = {
    entry_tags: [
      "entry_id:entries:id:NO ACTION:CASCADE",
      "tag_id:tags:id:NO ACTION:CASCADE",
    ],
    media: ["entry_id:entries:id:NO ACTION:CASCADE"],
    entry_music: [
      "cover_media_id:media:id:NO ACTION:RESTRICT",
      "entry_id:entries:id:NO ACTION:CASCADE",
      "media_id:media:id:NO ACTION:RESTRICT",
    ],
  };
  for (const [table, expected] of Object.entries(requiredForeignKeys)) {
    const actual = (db.pragma(`foreign_key_list('${table}')`) as Array<{
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
    }>).map((foreignKey) => [
      foreignKey.from,
      foreignKey.table,
      foreignKey.to,
      foreignKey.on_update,
      foreignKey.on_delete,
    ].join(":")).sort();
    if (actual.join("|") !== [...expected].sort().join("|")) {
      throw new Error("DIARY_SCHEMA_INCOMPLETE");
    }
  }
}

function normalizeSchemaSql(sql: string | null | undefined): string {
  return (sql ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim()
    .toLowerCase();
}

export function createInMemoryDiaryDatabase(): DiaryDatabase {
  const db = new Database(":memory:");
  migrateDiaryDatabase(db);
  validateCurrentDiarySchema(db);
  return db;
}

export function createDiaryDatabase(dataRoot: string): DiaryDatabase {
  mkdirSync(dataRoot, { recursive: true });
  const db = new Database(path.join(dataRoot, "diary.sqlite"));
  migrateDiaryDatabase(db);
  validateCurrentDiarySchema(db);
  return db;
}
