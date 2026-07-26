import type { Entry } from "@diary/contracts";
import { describe, expect, it } from "vitest";
import type { DayPage } from "../api/client";
import { createDayPageCache, mergeDayPages } from "./day-page-cache";

function entry(index: number): Entry {
  const minute = Math.floor(index / 60);
  const second = index % 60;
  const timestamp = `2026-07-26T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000+08:00`;
  return {
    id: `00000000-0000-4000-8000-${String(999_999_999_999 - index).padStart(12, "0")}`,
    title: `Entry ${index}`,
    markdown: `Body ${index}`,
    state: "published",
    publishedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    edited: false,
    tags: [],
    music: null,
  };
}

function page(pageIndex: number): DayPage {
  const entries = Array.from({ length: 120 }, (_, offset) => entry(pageIndex * 120 + offset));
  return {
    days: [{ day: "2026-07-26", totalEntries: 600, entries }],
    previousCursor: `before-${pageIndex}`,
    nextCursor: `after-${pageIndex}`,
  };
}

describe("day page cache", () => {
  it("merges same-day pages by entry id into one group and trims whole reloadable segments", () => {
    let cache = createDayPageCache(page(0));
    for (let pageIndex = 1; pageIndex < 5; pageIndex += 1) {
      cache = mergeDayPages(cache, page(pageIndex), "older", 480);
    }

    const ids = cache.days.flatMap((group) => group.entries.map((item) => item.id));
    expect(cache.days).toHaveLength(1);
    expect(cache.days[0]?.totalEntries).toBe(600);
    expect(ids).toHaveLength(480);
    expect(new Set(ids).size).toBe(480);
    expect(cache.previousCursor).toBe("before-1");
    expect(cache.nextCursor).toBe("after-4");

    cache = mergeDayPages(cache, page(0), "newer", 480);
    expect(cache.days.flatMap((group) => group.entries)).toHaveLength(480);
    expect(cache.previousCursor).toBe("before-0");
    expect(cache.nextCursor).toBe("after-3");
  });

  it("deduplicates an overlapping entry without duplicating its day section", () => {
    const first = page(0);
    const overlap = page(1);
    overlap.days[0]!.entries[0] = first.days[0]!.entries.at(-1)!;
    const cache = mergeDayPages(createDayPageCache(first), overlap, "older", 480);
    const ids = cache.days[0]!.entries.map((item) => item.id);

    expect(cache.days).toHaveLength(1);
    expect(ids).toHaveLength(239);
    expect(new Set(ids).size).toBe(239);
  });
});
