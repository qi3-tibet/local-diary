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
  const [heightVersion, setHeightVersion] = useState(0);
  const start = Math.min(Math.max(0, windowStart), Math.max(0, groups.length - (SIDE_DAYS * 2 + 1)));
  const end = Math.min(groups.length, start + SIDE_DAYS * 2 + 1);
  const visible = groups.slice(start, end);
  const timelineRef = useRef<HTMLElement>(null);
  const heights = useRef(new Map<string, number>());
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const needOlder = useRef(onNeedOlder);
  const needNewer = useRef(onNeedNewer);
  const scrollDirection = useRef<"up" | "down" | null>(null);
  const lastScrollY = useRef(typeof window === "undefined" ? 0 : window.scrollY);
  const anchor = useRef<{ day: string; top: number } | undefined>(undefined);
  const internalActiveDay = useRef<string | undefined>(undefined);
  const external = useRef<{ signature: string; day?: string } | undefined>(undefined);
  needOlder.current = onNeedOlder;
  needNewer.current = onNeedNewer;

  const groupSignature = groups.map((group) => group.day).join("|");
  useEffect(() => {
    const changed = external.current?.signature !== groupSignature || external.current?.day !== activeDay;
    external.current = { signature: groupSignature, day: activeDay };
    if (!changed || activeDay === internalActiveDay.current) {
      internalActiveDay.current = undefined;
      return;
    }
    if (activeIndex < start || activeIndex >= end) setWindowStart(Math.max(0, activeIndex - SIDE_DAYS));
  }, [activeDay, activeIndex, end, groupSignature, start]);

  function captureAnchor(): void {
    const sections = [...(timelineRef.current?.querySelectorAll<HTMLElement>("[data-day]") ?? [])];
    const nearest = sections.sort((left, right) => Math.abs(left.getBoundingClientRect().top) - Math.abs(right.getBoundingClientRect().top))[0];
    if (nearest) anchor.current = { day: nearest.dataset.day!, top: nearest.getBoundingClientRect().top };
  }

  function shiftWindow(delta: number): void {
    captureAnchor();
    setWindowStart((current) => {
      const next = Math.min(Math.max(0, current + delta), Math.max(0, groups.length - (SIDE_DAYS * 2 + 1)));
      const day = groups[Math.min(groups.length - 1, next + SIDE_DAYS)]?.day;
      if (day) {
        internalActiveDay.current = day;
        queueMicrotask(() => onActiveDayChange?.(day));
      }
      return next;
    });
  }


  useLayoutEffect(() => {
    const saved = anchor.current;
    if (!preserveAnchor || !saved) return;
    const node = timelineRef.current?.querySelector<HTMLElement>(`[data-day="${saved.day}"]`);
    if (!node) return;
    const delta = node.getBoundingClientRect().top - saved.top;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
    anchor.current = { day: saved.day, top: node.getBoundingClientRect().top };
  }, [heightVersion, start, preserveAnchor]);

  useEffect(() => {
    const trackDirection = () => {
      const next = window.scrollY;
      if (next !== lastScrollY.current) {
        scrollDirection.current = next > lastScrollY.current ? "down" : "up";
      }
      lastScrollY.current = next;
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
        if (day && Math.abs((heights.current.get(day) ?? 0) - item.contentRect.height) > 1) {
          captureAnchor();
          heights.current.set(day, item.contentRect.height);
          setHeightVersion((value) => value + 1);
        }
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
        if (item.target === topSentinel.current && scrollDirection.current === "up") {
          if (start > 0) shiftWindow(-SIDE_DAYS); else needNewer.current?.();
        }
        if (item.target === bottomSentinel.current && scrollDirection.current === "down") {
          if (end < groups.length) shiftWindow(SIDE_DAYS); else needOlder.current?.();
        }
      }
    }, { rootMargin: "400px 0px" });
    if (topSentinel.current) observer.observe(topSentinel.current);
    if (bottomSentinel.current) observer.observe(bottomSentinel.current);
    return () => observer.disconnect();
  }, [groupSignature, pagingEnabled, start, end]);

  if (!groups.length) return <main className="reading-page reading-page-empty"><h1 className="visually-hidden">DIARY</h1><p className="reading-status">NO PUBLISHED ENTRIES</p></main>;
  const omittedHeight = (items: typeof groups) => items.reduce((total, item) => total + (heights.current.get(item.day) ?? Math.max(180, item.entries.length * 110)), 0);
  return <main className="reading-page" ref={timelineRef}>
    <h1 className="visually-hidden">DIARY</h1>
    {start ? <div aria-hidden="true" style={{ height: omittedHeight(groups.slice(0, start)) }} /> : null}
    <div ref={topSentinel} aria-hidden="true" data-testid="top-window-sentinel" />
    {visible.map(({ day, entries: dayEntries }) => <section className="day" id={`day-${day}`} key={day} data-day={day} data-testid={`day-${day}`} tabIndex={-1}>
      <header className="day-heading"><strong>{day.slice(-2)}</strong><span>{formatEnglishDayMeta(day, dayEntries.length)}</span></header>
      {dayEntries.map((entry) => <EntryBody entry={entry} key={entry.id} onEdit={onEditEntry} onTrash={onTrashEntry} player={player} />)}
    </section>)}
    <div ref={bottomSentinel} aria-hidden="true" data-testid="bottom-window-sentinel" />
    {end < groups.length ? <div aria-hidden="true" style={{ height: omittedHeight(groups.slice(end)) }} /> : null}
  </main>;
}
