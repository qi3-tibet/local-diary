import type { Entry } from "@diary/contracts";
import { useEffect, useRef } from "react";
import { EntryBody } from "./EntryBody";
import { formatEnglishDayMeta, groupEntriesByBeijingDay } from "./date-groups";
import type { PlayerStore } from "../music/player-store";

type TimelineProps = {
  entries: Entry[];
  onActiveDayChange?: (day: string) => void;
  onEditEntry?: (entry: Entry) => void;
  onTrashEntry?: (entry: Entry) => void;
  player?: PlayerStore;
};

export function Timeline({
  entries,
  onActiveDayChange,
  onEditEntry,
  onTrashEntry,
  player,
}: TimelineProps) {
  const groups = groupEntriesByBeijingDay(entries);
  const observedDays = groups.map(({ day }) => day).join("|");
  const timelineRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!onActiveDayChange || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (observations) => {
        const nearest = observations
          .filter((observation) => observation.isIntersecting)
          .sort(
            (left, right) =>
              Math.abs(left.boundingClientRect.top) - Math.abs(right.boundingClientRect.top),
          )[0];
        const day = nearest?.target.getAttribute("data-day");
        if (day) onActiveDayChange(day);
      },
      { rootMargin: "-12% 0px -68% 0px", threshold: 0 },
    );

    const daySections = timelineRef.current?.querySelectorAll<HTMLElement>("[data-day]") ?? [];
    daySections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [observedDays, onActiveDayChange]);

  if (groups.length === 0) {
    return (
      <main className="reading-page reading-page-empty">
        <p className="reading-status">NO PUBLISHED ENTRIES</p>
      </main>
    );
  }

  return (
    <main className="reading-page" ref={timelineRef}>
      {groups.map(({ day, entries: dayEntries }) => (
        <section className="day" id={`day-${day}`} key={day} data-day={day} data-testid={`day-${day}`}>
          <header className="day-heading">
            <strong>{day.slice(-2)}</strong>
            <span>{formatEnglishDayMeta(day, dayEntries.length)}</span>
          </header>
          {dayEntries.map((entry) => (
            <EntryBody
              entry={entry}
              key={entry.id}
              onEdit={onEditEntry}
              onTrash={onTrashEntry}
              player={player}
            />
          ))}
        </section>
      ))}
    </main>
  );
}
