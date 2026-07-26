import type { Entry } from "@diary/contracts";
import { useEffect, useMemo, useRef } from "react";
import type { PlayerStore } from "../music/player-store";
import { EntryBody } from "./EntryBody";
import { formatEnglishDayMeta, groupEntriesByBeijingDay } from "./date-groups";

type Props = {
  entries: Entry[];
  activeDay?: string;
  onActiveDayChange?: (day: string) => void;
  onEditEntry?: (entry: Entry) => void;
  onTrashEntry?: (entry: Entry) => void;
  player?: PlayerStore;
};

const SIDE_DAYS = 7;

/** Keeps DOM work bounded even when a caller has a wide cached timeline window. */
export function WindowedTimeline({ entries, activeDay, onActiveDayChange, onEditEntry, onTrashEntry, player }: Props) {
  const groups = useMemo(() => groupEntriesByBeijingDay(entries), [entries]);
  const activeIndex = Math.max(0, groups.findIndex((group) => group.day === activeDay));
  const start = Math.max(0, activeIndex - SIDE_DAYS);
  const end = Math.min(groups.length, activeIndex + SIDE_DAYS + 1);
  const visible = groups.slice(start, end);
  const timelineRef = useRef<HTMLElement>(null);
  const heights = useRef(new Map<string, number>());

  useEffect(() => {
    if (!onActiveDayChange || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((observations) => {
      const nearest = observations.filter((item) => item.isIntersecting).sort(
        (left, right) => Math.abs(left.boundingClientRect.top) - Math.abs(right.boundingClientRect.top),
      )[0];
      const day = nearest?.target.getAttribute("data-day");
      if (day) onActiveDayChange(day);
    }, { rootMargin: "-12% 0px -68% 0px", threshold: 0 });
    timelineRef.current?.querySelectorAll<HTMLElement>("[data-day]").forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [onActiveDayChange, visible.map((group) => group.day).join("|")]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((observations) => {
      observations.forEach((item) => {
        const day = item.target.getAttribute("data-day");
        if (day) heights.current.set(day, item.contentRect.height);
      });
    });
    timelineRef.current?.querySelectorAll<HTMLElement>("[data-day]").forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [visible.map((group) => group.day).join("|")]);

  if (!groups.length) return <main className="reading-page reading-page-empty"><h1 className="visually-hidden">DIARY</h1><p className="reading-status">NO PUBLISHED ENTRIES</p></main>;
  const omittedHeight = (items: typeof groups) => items.reduce((total, item) => total + (heights.current.get(item.day) ?? 0), 0);
  return <main className="reading-page" ref={timelineRef}>
    <h1 className="visually-hidden">DIARY</h1>
    {start ? <div aria-hidden="true" style={{ height: omittedHeight(groups.slice(0, start)) }} /> : null}
    {visible.map(({ day, entries: dayEntries }) => <section className="day" id={`day-${day}`} key={day} data-day={day} data-testid={`day-${day}`}>
      <header className="day-heading"><strong>{day.slice(-2)}</strong><span>{formatEnglishDayMeta(day, dayEntries.length)}</span></header>
      {dayEntries.map((entry) => <EntryBody entry={entry} key={entry.id} onEdit={onEditEntry} onTrash={onTrashEntry} player={player} />)}
    </section>)}
    {end < groups.length ? <div aria-hidden="true" style={{ height: omittedHeight(groups.slice(end)) }} /> : null}
  </main>;
}
