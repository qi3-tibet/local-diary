import type { Entry } from "@diary/contracts";

const BEIJING_TIME_ZONE = "Asia/Shanghai";

export type DayGroup = {
  day: string;
  entries: Entry[];
};

function beijingDay(isoTimestamp: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BEIJING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(isoTimestamp));
  const value = (part: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === part)?.value ?? "";

  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function groupEntriesByBeijingDay(entries: Entry[]): DayGroup[] {
  const published = entries
    .filter(
      (entry): entry is Entry & { publishedAt: string } =>
        entry.state === "published" && entry.publishedAt !== null,
    )
    .sort((left, right) =>
      right.publishedAt.localeCompare(left.publishedAt) || right.id.localeCompare(left.id),
    );
  const grouped = new Map<string, Entry[]>();

  for (const entry of published) {
    const day = beijingDay(entry.publishedAt);
    grouped.set(day, [...(grouped.get(day) ?? []), entry]);
  }

  return [...grouped].map(([day, dayEntries]) => ({ day, entries: dayEntries }));
}

export function formatEnglishDayMeta(day: string, entryCount: number): string {
  const date = new Date(`${day}T12:00:00+08:00`);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: BEIJING_TIME_ZONE,
    weekday: "long",
  }).format(date);
  const month = new Intl.DateTimeFormat("en-US", {
    timeZone: BEIJING_TIME_ZONE,
    month: "long",
  }).format(date);
  const noun = entryCount === 1 ? "ENTRY" : "ENTRIES";

  return `${weekday.toUpperCase()} · ${month.toUpperCase()} · ${entryCount} ${noun}`;
}

export function formatDateLabel(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BEIJING_TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(`${day}T12:00:00+08:00`));
}

export function formatRailMonth(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BEIJING_TIME_ZONE,
    month: "short",
  })
    .format(new Date(`${day}T12:00:00+08:00`))
    .toUpperCase();
}

export function formatEntryTime(isoTimestamp: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BEIJING_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(isoTimestamp));
}
