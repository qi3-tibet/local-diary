import { describe, expect, it } from "vitest";
import { createTestDatabase } from "@diary/test-support";
import { EntryRepository } from "../src/entries/repository.js";

describe("EntryRepository", () => {
  it("persists exactly one draft", () => {
    const db = createTestDatabase();
    const repository = new EntryRepository(db);
    repository.saveDraft({ title: "雨后的街道", markdown: "空气变凉了。", tags: ["散步"] });
    repository.saveDraft({ title: "更新后的标题", markdown: "仍然在想。", tags: [] });
    expect(repository.getDraft()).toMatchObject({
      title: "更新后的标题",
      state: "draft",
    });
    expect(repository.countByState("draft")).toBe(1);
  });

  it("accepts a date-only legacy entry as a signed pagination boundary", () => {
    const db = createTestDatabase();
    const repository = new EntryRepository(db);
    const id = "10000000-0000-4000-8000-000000000001";
    db.prepare(`
      INSERT INTO entries (
        id, title, markdown, state, published_at, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, 'published', ?, ?, ?, NULL)
    `).run(
      id,
      "旧记录",
      "没有记录具体时间。",
      "2026-06-05",
      "2026-06-06T03:00:00.000Z",
      "2026-06-06T03:00:00.000Z",
    );

    const page = repository.selectDayWindow({ direction: "older", limitEntries: 1 });
    expect(page.days[0]?.day).toBe("2026-06-05");
    expect(page.days[0]?.entries[0]?.publishedAt).toBe("2026-06-05");
    expect(() => repository.selectDayWindow({
      cursor: page.nextCursor,
      direction: "older",
      limitEntries: 1,
    })).not.toThrow();
  });
});
