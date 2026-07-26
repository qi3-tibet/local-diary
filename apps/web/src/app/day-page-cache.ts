import type { Entry } from "@diary/contracts";
import type { DayPage } from "../api/client";

export type DayPageCache = DayPage & {
  segments: DayPage[];
};

export function createDayPageCache(page: DayPage): DayPageCache {
  return buildCache([page]);
}

export function mergeDayPages(
  current: DayPageCache,
  incoming: DayPage,
  direction: "older" | "newer",
  maxEntries = 480,
): DayPageCache {
  const duplicate = current.segments.some((segment) =>
    segment.previousCursor === incoming.previousCursor
    && segment.nextCursor === incoming.nextCursor,
  );
  let segments = duplicate
    ? [...current.segments]
    : direction === "older"
      ? [...current.segments, incoming]
      : [incoming, ...current.segments];
  while (segments.length > 1 && uniqueEntryCount(segments) > maxEntries) {
    if (direction === "older") segments.shift();
    else segments.pop();
  }
  return buildCache(segments);
}

function buildCache(segments: DayPage[]): DayPageCache {
  const entries = new Map<string, Entry>();
  const totals = new Map<string, number>();
  for (const segment of segments) {
    for (const group of segment.days) {
      totals.set(group.day, Math.max(totals.get(group.day) ?? 0, group.totalEntries));
      for (const entry of group.entries) entries.set(entry.id, entry);
    }
  }
  const groups = new Map<string, Entry[]>();
  for (const entry of [...entries.values()].sort(compareEntriesDescending)) {
    const day = entry.publishedAt?.slice(0, 10);
    if (!day) continue;
    groups.set(day, [...(groups.get(day) ?? []), entry]);
  }
  return {
    days: [...groups].map(([day, dayEntries]) => ({
      day,
      totalEntries: totals.get(day) ?? dayEntries.length,
      entries: dayEntries,
    })),
    previousCursor: segments[0]?.previousCursor ?? null,
    nextCursor: segments.at(-1)?.nextCursor ?? null,
    segments,
  };
}

function uniqueEntryCount(segments: DayPage[]): number {
  return new Set(
    segments.flatMap((segment) =>
      segment.days.flatMap((group) => group.entries.map((entry) => entry.id)),
    ),
  ).size;
}

function compareEntriesDescending(left: Entry, right: Entry): number {
  const timestamp = (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "");
  return timestamp || right.id.localeCompare(left.id);
}
