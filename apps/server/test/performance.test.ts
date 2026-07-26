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

  it("uses a stable cursor day window without gaps when timestamps match", () => {
    const { database, close } = seedLargeDiary(80, { days: 4, sameMinute: true });
    try {
      const repository = new EntryRepository(database);
      const first = repository.selectDayWindow({ direction: "older", limitDays: 2 });
      const second = repository.selectDayWindow({
        cursor: first.nextCursor,
        direction: "older",
        limitDays: 2,
      });
      const firstDays = first.days.map((group) => group.day);
      const secondDays = second.days.map((group) => group.day);
      expect(firstDays).toHaveLength(2);
      expect(secondDays).toHaveLength(2);
      expect(new Set([...firstDays, ...secondDays]).size).toBe(4);
      expect(first.days.flatMap((group) => group.entries).every((entry) => entry.state === "published")).toBe(true);
      expect(first.days.flatMap((group) => group.entries).every((entry) => entry.music === null)).toBe(true);
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
      expect(jumped.json().days).toHaveLength(5);
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

  it("rejects tampered and wrong-direction opaque cursors while paging both directions without gaps", () => {
    const { database, close } = seedLargeDiary(160, { days: 8, sameMinute: true });
    try {
      const repository = new EntryRepository(database);
      const newest = repository.selectDayWindow({ direction: "older", limitDays: 2 });
      expect(() => repository.selectDayWindow({
        cursor: `${newest.nextCursor}x`, direction: "older", limitDays: 2,
      })).toThrow("Invalid day cursor");
      expect(() => repository.selectDayWindow({
        cursor: newest.nextCursor, direction: "newer", limitDays: 2,
      })).toThrow("Invalid day cursor");
      const older = repository.selectDayWindow({ cursor: newest.nextCursor, direction: "older", limitDays: 2 });
      const back = repository.selectDayWindow({ cursor: older.previousCursor, direction: "newer", limitDays: 2 });
      expect(back.days.map((group) => group.day)).toEqual(newest.days.map((group) => group.day));
      expect(new Set([...newest.days, ...older.days].map((group) => group.day)).size).toBe(4);
    } finally {
      close();
    }
  });

  it("has an index-backed day cursor query plan", () => {
    const { database, close } = seedLargeDiary(100);
    try {
      const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT substr(published_at, 1, 10) AS day FROM entries WHERE state = 'published' ORDER BY day DESC LIMIT 14`).all() as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(" ")).toContain("entries_published_day_cursor");
    } finally {
      close();
    }
  });
});
