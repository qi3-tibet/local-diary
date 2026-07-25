import { randomUUID } from "node:crypto";
import { draftInputSchema, type DraftInput, type Entry } from "@diary/contracts";
import type { DiaryDatabase } from "../db/client.js";

type EntryRow = {
  id: string;
  title: string;
  markdown: string;
  state: Entry["state"];
  published_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export class EntryRepository {
  constructor(private readonly db: DiaryDatabase) {}

  saveDraft(input: DraftInput): Entry {
    const value = draftInputSchema.parse(input);
    const now = new Date().toISOString();
    const save = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT id FROM entries WHERE state = 'draft'")
        .get() as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();

      if (existing) {
        this.db.prepare(`
          UPDATE entries SET title = ?, markdown = ?, updated_at = ? WHERE id = ?
        `).run(value.title, value.markdown, now, id);
      } else {
        this.db.prepare(`
          INSERT INTO entries (id, title, markdown, state, published_at, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, 'draft', NULL, ?, ?, NULL)
        `).run(id, value.title, value.markdown, now, now);
      }

      this.replaceTags(id, value.tags);
      return id;
    });

    const id = save();
    return this.getById(id)!;
  }

  getDraft(): Entry | null {
    const row = this.db.prepare(`
      SELECT id, title, markdown, state, published_at, created_at, updated_at, deleted_at
      FROM entries WHERE state = 'draft'
    `).get() as EntryRow | undefined;
    return row ? this.toEntry(row) : null;
  }

  countByState(state: Entry["state"]): number {
    const result = this.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE state = ?")
      .get(state) as { count: number };
    return result.count;
  }

  private getById(id: string): Entry | null {
    const row = this.db.prepare(`
      SELECT id, title, markdown, state, published_at, created_at, updated_at, deleted_at
      FROM entries WHERE id = ?
    `).get(id) as EntryRow | undefined;
    return row ? this.toEntry(row) : null;
  }

  private replaceTags(entryId: string, tags: string[]): void {
    this.db.prepare("DELETE FROM entry_tags WHERE entry_id = ?").run(entryId);
    for (const name of new Set(tags)) {
      this.db.prepare("INSERT INTO tags (id, name) VALUES (?, ?) ON CONFLICT(name) DO NOTHING")
        .run(randomUUID(), name);
      const tag = this.db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as { id: string };
      this.db.prepare("INSERT INTO entry_tags (entry_id, tag_id) VALUES (?, ?)").run(entryId, tag.id);
    }
  }

  private toEntry(row: EntryRow): Entry {
    const tags = this.db.prepare(`
      SELECT tags.name FROM tags
      INNER JOIN entry_tags ON entry_tags.tag_id = tags.id
      WHERE entry_tags.entry_id = ?
      ORDER BY tags.name
    `).all(row.id) as Array<{ name: string }>;
    return {
      id: row.id,
      title: row.title,
      markdown: row.markdown,
      state: row.state,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      tags: tags.map((tag) => tag.name),
    };
  }
}
