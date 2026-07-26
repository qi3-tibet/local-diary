import type { Entry } from "@diary/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  onNeedOlder?: () => void;
  onNeedNewer?: () => void;
  preserveAnchor?: boolean;
  pagingEnabled?: boolean;
};

const SIDE_DAYS = 7;

/** Keeps DOM work bounded even when a caller has a wide cached timeline window. */
export function WindowedTimeline({ entries, activeDay, onActiveDayChange, onEditEntry, onTrashEntry, player, onNeedOlder, onNeedNewer, preserveAnchor = true, pagingEnabled = true }: Props) {
  const groups = useMemo(() => groupEntriesByBeijingDay(entries), [entries]);
  const activeIndex = Math.max(0, groups.findIndex((group) => group.day === activeDay));
  const [windowStart, setWindowStart] = useState(0);
  const start = Math.min(Math.max(0, windowStart), Math.max(0, groups.length - (SIDE_DAYS * 2 + 1)));
  const end = Math.min(groups.length, start + SIDE_DAYS * 2 + 1);
  const visible = groups.slice(start, end);
  const timelineRef = useRef<HTMLElement>(null);
  const heights = useRef(new Map<string, number>());
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const needOlder = useRef(onNeedOlder);
  const needNewer = useRef(onNeedNewer);
  const previous = useRef<{ first?: string; height: number }>({ height: 0 });
  const scrollDirection = useRef<"up" | "down" | null>(null);
  const lastScrollY = useRef(typeof window === "undefined" ? 0 : window.scrollY);
  const edgeRequest = useRef<"older" | "newer" | null>(null);
  needOlder.current = onNeedOlder;
  needNewer.current = onNeedNewer;

  useEffect(() => {
    if (activeIndex < start || activeIndex >= end) {
      setWindowStart(Math.max(0, activeIndex - SIDE_DAYS));
    }
  }, [activeIndex, end, start]);


  useLayoutEffect(() => {
    const root = document.documentElement;
    const nextFirst = groups[0]?.day;
    const before = previous.current;
    const afterHeight = root.scrollHeight;
    if (preserveAnchor && before.first && nextFirst !== before.first && afterHeight > before.height && window.scrollY > 0) {
      window.scrollBy(0, afterHeight - before.height);
    }
    previous.current = { first: nextFirst, height: afterHeight };
  }, [groups]);

  useEffect(() => {
    const trackDirection = () => {
      const next = window.scrollY;
      if (next !== lastScrollY.current) {
        scrollDirection.current = next > lastScrollY.current ? "down" : "up";
      }
      lastScrollY.current = next;
      const atTop = next <= 4;
      const atBottom = next + window.innerHeight >= document.documentElement.scrollHeight - 4;
      if (!pagingEnabled) return;
      const edge = atTop ? "newer" : atBottom ? "older" : null;
      if (!edge) {
        edgeRequest.current = null;
        return;
      }
      if (edgeRequest.current === edge) return;
      edgeRequest.current = edge;
      if (edge === "older") { setWindowStart((current) => current + SIDE_DAYS); needOlder.current?.(); }
      else { setWindowStart((current) => Math.max(0, current - SIDE_DAYS)); needNewer.current?.(); }
      window.setTimeout(() => { edgeRequest.current = null; }, 250);
    };
    window.addEventListener("scroll", trackDirection, { passive: true });
    return () => window.removeEventListener("scroll", trackDirection);
  }, [pagingEnabled]);

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

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((items) => {
      for (const item of items) {
        if (!item.isIntersecting) continue;
        if (!pagingEnabled) continue;
        if (item.target === topSentinel.current && scrollDirection.current === "up") { setWindowStart((current) => Math.max(0, current - SIDE_DAYS)); needNewer.current?.(); }
        if (item.target === bottomSentinel.current && scrollDirection.current === "down") { setWindowStart((current) => current + SIDE_DAYS); needOlder.current?.(); }
      }
    }, { rootMargin: "400px 0px" });
    if (topSentinel.current) observer.observe(topSentinel.current);
    if (bottomSentinel.current) observer.observe(bottomSentinel.current);
    return () => observer.disconnect();
  }, [groups.map((group) => group.day).join("|"), pagingEnabled]);

  if (!groups.length) return <main className="reading-page reading-page-empty"><h1 className="visually-hidden">DIARY</h1><p className="reading-status">NO PUBLISHED ENTRIES</p></main>;
  const omittedHeight = (items: typeof groups) => items.reduce((total, item) => total + (heights.current.get(item.day) ?? Math.max(180, item.entries.length * 110)), 0);
  return <main className="reading-page" ref={timelineRef}>
    <h1 className="visually-hidden">DIARY</h1>
    <div ref={topSentinel} aria-hidden="true" />
    {start ? <div aria-hidden="true" style={{ height: omittedHeight(groups.slice(0, start)) }} /> : null}
    {visible.map(({ day, entries: dayEntries }) => <section className="day" id={`day-${day}`} key={day} data-day={day} data-testid={`day-${day}`} tabIndex={-1}>
      <header className="day-heading"><strong>{day.slice(-2)}</strong><span>{formatEnglishDayMeta(day, dayEntries.length)}</span></header>
      {dayEntries.map((entry) => <EntryBody entry={entry} key={entry.id} onEdit={onEditEntry} onTrash={onTrashEntry} player={player} />)}
    </section>)}
    {end < groups.length ? <div aria-hidden="true" style={{ height: omittedHeight(groups.slice(end)) }} /> : null}
    <div ref={bottomSentinel} aria-hidden="true" />
  </main>;
}
