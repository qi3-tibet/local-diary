import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { EntryRepository } from "../src/entries/repository.js";
import { seedLargeDiary } from "../test-support/seed-large-diary.js";
import { buildServer } from "../src/app.js";

describe("large diary performance", () => {
  it("searches 20,000 published entries within 150 ms after warmup", () => {
    const { database, close } = seedLargeDiary(20_000);
    try {
      const repository = new EntryRepository(database);
      expect(repository.searchPublished("水滴", 20).length).toBeGreaterThan(0);
      const started = performance.now();
      const results = repository.searchPublished("水滴", 20);
      expect(results.length).toBeGreaterThan(0);
      expect(performance.now() - started).toBeLessThan(150);
    } finally {
      close();
    }
  });

  it("bounds a 20,000-entry day page and reports the full day count", () => {
    const { database, close } = seedLargeDiary(20_000, { days: 1 });
    try {
      const repository = new EntryRepository(database);
      const page = repository.selectDaysAround("2020-07-26", 120);
      expect(page.days).toHaveLength(1);
      expect(page.days[0]?.totalEntries).toBe(20_000);
      expect(page.days.flatMap((group) => group.entries)).toHaveLength(120);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(80_000);
      const expected = (database.prepare(`
        SELECT id FROM entries
        WHERE state = 'published'
        ORDER BY published_at DESC, id DESC
      `).all() as Array<{ id: string }>).map(({ id }) => id);
      const traversed: string[] = [];
      let cursor: string | null = null;
      for (let pageIndex = 0; pageIndex < 200; pageIndex += 1) {
        const next = repository.selectDayWindow({
          cursor,
          direction: "older",
          limitEntries: 120,
        });
        const ids = next.days.flatMap((group) => group.entries.map((entry) => entry.id));
        if (!ids.length) break;
        traversed.push(...ids);
        cursor = next.nextCursor;
      }
      expect(traversed).toEqual(expected);
      expect(new Set(traversed).size).toBe(20_000);
    } finally {
      close();
    }
  });

  it("exposes validated cursor pages and a centered date jump", async () => {
    const { database, close } = seedLargeDiary(400, { days: 20 });
    const server = buildServer({ database, scheduleBackups: false });
    try {
      const jumped = await server.inject({
        method: "GET",
        url: "/api/v1/entries/days?day=2020-08-05&limit=5",
      });
      expect(jumped.statusCode).toBe(200);
      expect(jumped.json().days.map((group: { day: string }) => group.day)).toContain("2020-08-05");
      expect(jumped.json().days.flatMap((group: { entries: unknown[] }) => group.entries)).toHaveLength(5);
      expect(jumped.json().days.every((group: { totalEntries?: number }) => Number.isInteger(group.totalEntries))).toBe(true);
      const invalid = await server.inject({
        method: "GET",
        url: "/api/v1/entries/days?cursor=not-a-cursor",
      });
      expect(invalid.statusCode).toBe(400);
      const invalidDirection = await server.inject({
        method: "GET",
        url: "/api/v1/entries/days?direction=sideways",
      });
      expect(invalidDirection.statusCode).toBe(400);
      const impossibleDate = await server.inject({
        method: "GET",
        url: "/api/v1/entries/days?day=2020-02-31",
      });
      expect(impossibleDate.statusCode).toBe(400);
    } finally {
      await server.close();
      close();
    }
  });

  it("pages a dense same-millisecond day both directions without gaps", () => {
    const { database, close } = seedLargeDiary(360, { days: 1, sameMinute: true });
    try {
      const repository = new EntryRepository(database);
      const expected = (database.prepare(`
        SELECT id FROM entries
        WHERE state = 'published'
        ORDER BY published_at DESC, id DESC
      `).all() as Array<{ id: string }>).map(({ id }) => id);
      const newest = repository.selectDayWindow({ direction: "older", limitEntries: 120 });
      expect(() => repository.selectDayWindow({
        cursor: `${newest.nextCursor}x`, direction: "older", limitEntries: 120,
      })).toThrow("Invalid entry cursor");
      expect(() => repository.selectDayWindow({
        cursor: newest.nextCursor, direction: "newer", limitEntries: 120,
      })).toThrow("Invalid entry cursor");

      const older = repository.selectDayWindow({ cursor: newest.nextCursor, direction: "older", limitEntries: 120 });
      const oldest = repository.selectDayWindow({ cursor: older.nextCursor, direction: "older", limitEntries: 120 });
      const forward = [...newest.days, ...older.days, ...oldest.days].flatMap((group) => group.entries.map((entry) => entry.id));
      expect(forward).toEqual(expected);
      expect(new Set(forward).size).toBe(360);

      const backToOlder = repository.selectDayWindow({ cursor: oldest.previousCursor, direction: "newer", limitEntries: 120 });
      const backToNewest = repository.selectDayWindow({ cursor: backToOlder.previousCursor, direction: "newer", limitEntries: 120 });
      expect(backToOlder.days.flatMap((group) => group.entries.map((entry) => entry.id)))
        .toEqual(older.days.flatMap((group) => group.entries.map((entry) => entry.id)));
      expect(backToNewest.days.flatMap((group) => group.entries.map((entry) => entry.id)))
        .toEqual(newest.days.flatMap((group) => group.entries.map((entry) => entry.id)));
    } finally {
      close();
    }
  });

  it("centers a bounded page on an exact published entry ID", () => {
    const { database, close } = seedLargeDiary(360, { days: 1, sameMinute: true });
    try {
      const repository = new EntryRepository(database);
      const target = (database.prepare(`
        SELECT id FROM entries
        WHERE state = 'published'
        ORDER BY published_at DESC, id DESC
        LIMIT 1 OFFSET 250
      `).get() as { id: string }).id;
      const page = repository.selectEntriesAround(target, 120);
      const ids = page.days.flatMap((group) => group.entries.map((entry) => entry.id));
      expect(ids).toHaveLength(120);
      expect(ids).toContain(target);
      expect(page.days[0]?.totalEntries).toBe(360);
      expect(() => repository.selectEntriesAround("not-a-uuid", 120)).toThrow("Invalid entry target");
      const draftId = repository.saveDraft({ title: "draft", markdown: "draft", tags: [] }).id;
      expect(() => repository.selectEntriesAround(draftId, 120)).toThrow("Published entry not found");
    } finally {
      close();
    }
  });

  it("strictly rejects signed cursors with invalid entry boundaries", () => {
    const { database, close } = seedLargeDiary(10, { days: 1 });
    const key = Buffer.alloc(32, 7);
    try {
      const repository = new EntryRepository(database, undefined, key);
      for (const payload of [
        { publishedAt: "2020-02-31T08:00:00.000+08:00", id: "00000000-0000-4000-8000-000000000001", direction: "older", v: 2 },
        { publishedAt: "2020-07-26T08:00:00.000+08:00", id: "not-an-id", direction: "older", v: 2 },
        { publishedAt: "2020-07-26T08:00:00.000+08:00", id: "00000000-0000-4000-8000-000000000001", direction: "older", v: 1 },
      ]) {
        const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
        const signature = createHmac("sha256", key).update(encoded).digest("base64url");
        expect(() => repository.selectDayWindow({
          cursor: `${encoded}.${signature}`,
          direction: "older",
          limitEntries: 5,
        })).toThrow("Invalid entry cursor");
      }
    } finally {
      close();
    }
  });

  it("has an index-backed entry cursor query plan", () => {
    const { database, close } = seedLargeDiary(100);
    try {
      const plan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT id, published_at FROM entries
        WHERE state = 'published'
        ORDER BY published_at DESC, id DESC
        LIMIT 120
      `).all() as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(" ")).toContain("entries_published_cursor");
    } finally {
      close();
    }
  });
});
