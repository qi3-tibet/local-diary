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
  navigationResetKey?: number;
};

const SIDE_DAYS = 7;

/** Keeps DOM work bounded even when a caller has a wide cached timeline window. */
export function WindowedTimeline({ entries, activeDay, onActiveDayChange, onEditEntry, onTrashEntry, player, onNeedOlder, onNeedNewer, preserveAnchor = true, pagingEnabled = true, navigationResetKey = 0 }: Props) {
  const groups = useMemo(() => groupEntriesByBeijingDay(entries), [entries]);
  const activeIndex = Math.max(0, groups.findIndex((group) => group.day === activeDay));
  const [windowStart, setWindowStart] = useState(0);
  const [heightVersion, setHeightVersion] = useState(0);
  const maxStart = Math.max(0, groups.length - (SIDE_DAYS * 2 + 1));
  const start = Math.min(Math.max(0, windowStart), maxStart);
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
  const positions = useRef(new Map<string, number>());
  const internalActiveDay = useRef<string | undefined>(undefined);
  const external = useRef<{ signature: string; day?: string } | undefined>(undefined);
  const animationFrame = useRef<number | undefined>(undefined);
  const lastBoundary = useRef<string | undefined>(undefined);
  const boundaryArmed = useRef({ top: true, bottom: true });
  const pendingLoads = useRef<Partial<Record<"top" | "bottom", { count: number; first?: string }>>>({});
  const previousNavigationResetKey = useRef(navigationResetKey);
  const timelineState = useRef({ start, end, count: groups.length, first: groups[0]?.day, visibleFirst: visible[0]?.day, visibleLast: visible.at(-1)?.day, pagingEnabled });
  timelineState.current = { start, end, count: groups.length, first: groups[0]?.day, visibleFirst: visible[0]?.day, visibleLast: visible.at(-1)?.day, pagingEnabled };
  needOlder.current = onNeedOlder;
  needNewer.current = onNeedNewer;

  const groupSignature = groups.map((group) => group.day).join("|");
  useEffect(() => {
    if (previousNavigationResetKey.current === navigationResetKey) return;
    previousNavigationResetKey.current = navigationResetKey;
    lastBoundary.current = undefined;
    boundaryArmed.current = { top: true, bottom: true };
    pendingLoads.current = {};
  }, [navigationResetKey]);

  useEffect(() => {
    const previousExternal = external.current;
    const changed = previousExternal?.signature !== groupSignature || previousExternal?.day !== activeDay;
    external.current = { signature: groupSignature, day: activeDay };
    if (!changed || activeDay === internalActiveDay.current) {
      internalActiveDay.current = undefined;
      return;
    }
    if (activeIndex < start || activeIndex >= end) {
      lastBoundary.current = undefined;
      setWindowStart(Math.min(maxStart, Math.max(0, activeIndex - SIDE_DAYS)));
    }
  }, [activeDay, activeIndex, end, groupSignature, maxStart, start]);

  function recordPositions(): void {
    timelineRef.current?.querySelectorAll<HTMLElement>("[data-day]").forEach((section) => {
      const day = section.dataset.day;
      if (day) positions.current.set(day, section.getBoundingClientRect().top);
    });
  }

  function captureAnchor(): void {
    const sections = [...(timelineRef.current?.querySelectorAll<HTMLElement>("[data-day]") ?? [])];
    const nearest = sections.sort((left, right) => Math.abs(left.getBoundingClientRect().top) - Math.abs(right.getBoundingClientRect().top))[0];
    if (nearest) anchor.current = { day: nearest.dataset.day!, top: nearest.getBoundingClientRect().top };
  }

  function captureRecordedAnchor(): void {
    const mounted = [...(timelineRef.current?.querySelectorAll<HTMLElement>("[data-day]") ?? [])];
    const nearest = mounted
      .map((section) => ({ day: section.dataset.day!, top: positions.current.get(section.dataset.day!) }))
      .filter((candidate): candidate is { day: string; top: number } => candidate.top !== undefined)
      .sort((left, right) => Math.abs(left.top) - Math.abs(right.top))[0];
    if (nearest) anchor.current = nearest;
  }

  function shiftWindow(delta: number): void {
    captureAnchor();
    setWindowStart((current) => {
      const next = Math.min(Math.max(0, current + delta), maxStart);
      const day = groups[Math.min(groups.length - 1, next + SIDE_DAYS)]?.day;
      if (day) {
        internalActiveDay.current = day;
        queueMicrotask(() => onActiveDayChange?.(day));
      }
      return next;
    });
  }

  const shiftWindowRef = useRef(shiftWindow);
  shiftWindowRef.current = shiftWindow;

  useLayoutEffect(() => {
    for (const side of ["top", "bottom"] as const) {
      const pending = pendingLoads.current[side];
      if (!pending || groups.length <= pending.count) continue;
      delete pendingLoads.current[side];
      lastBoundary.current = undefined;
      if (side === "bottom") {
        shiftWindowRef.current(SIDE_DAYS);
      } else {
        const oldFirst = pending.first ? groups.findIndex((group) => group.day === pending.first) : -1;
        const next = Math.max(0, oldFirst - SIDE_DAYS);
        setWindowStart(next);
        const day = groups[Math.min(groups.length - 1, next + SIDE_DAYS)]?.day;
        if (day) {
          internalActiveDay.current = day;
          queueMicrotask(() => onActiveDayChange?.(day));
        }
      }
    }
  }, [groupSignature, groups, onActiveDayChange]);

  useLayoutEffect(() => {
    const saved = anchor.current;
    if (preserveAnchor && saved) {
      const node = timelineRef.current?.querySelector<HTMLElement>(`[data-day="${saved.day}"]`);
      if (node) {
        const delta = node.getBoundingClientRect().top - saved.top;
        if (Math.abs(delta) > 1) window.scrollBy(0, delta);
        anchor.current = { day: saved.day, top: node.getBoundingClientRect().top };
      }
    }
    recordPositions();
  }, [groupSignature, heightVersion, start, preserveAnchor]);

  useEffect(() => {
    const trackDirection = () => {
      if (animationFrame.current !== undefined) return;
      animationFrame.current = window.requestAnimationFrame(() => {
        animationFrame.current = undefined;
        const next = window.scrollY;
        if (next !== lastScrollY.current) {
          const direction = next > lastScrollY.current ? "down" : "up";
          if (scrollDirection.current && direction !== scrollDirection.current) lastBoundary.current = undefined;
          scrollDirection.current = direction;
          const current = timelineState.current;
          const topBounds = topSentinel.current?.getBoundingClientRect();
          const bottomBounds = bottomSentinel.current?.getBoundingClientRect();
          const isNear = (bounds?: DOMRect) => Boolean(bounds && bounds.bottom >= -400 && bounds.top <= window.innerHeight + 400);
          if (!isNear(topBounds)) boundaryArmed.current.top = true;
          if (!isNear(bottomBounds)) boundaryArmed.current.bottom = true;
          const side = direction === "down" ? "bottom" : "top";
          const bounds = side === "bottom" ? bottomBounds : topBounds;
          const boundaryDay = direction === "down" ? current.visibleLast : current.visibleFirst;
          const key = `${side}:${boundaryDay ?? ""}:${current.count}`;
          const nearBoundary = isNear(bounds);
          if (current.pagingEnabled && nearBoundary && boundaryArmed.current[side] && lastBoundary.current !== key) {
            boundaryArmed.current[side] = false;
            lastBoundary.current = key;
            if (side === "bottom" && current.end < current.count) {
              shiftWindowRef.current(SIDE_DAYS);
            } else if (side === "top" && current.start > 0) {
              shiftWindowRef.current(-SIDE_DAYS);
            } else if (!pendingLoads.current[side]) {
              pendingLoads.current[side] = { count: current.count, first: current.first };
              if (side === "bottom") needOlder.current?.();
              else needNewer.current?.();
            }
          }
        }
        lastScrollY.current = next;
        recordPositions();
      });
    };
    window.addEventListener("scroll", trackDirection, { passive: true });
    return () => {
      window.removeEventListener("scroll", trackDirection);
      if (animationFrame.current !== undefined) window.cancelAnimationFrame(animationFrame.current);
    };
  }, []);

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
      let changed = false;
      for (const item of observations) {
        if (!timelineRef.current?.contains(item.target)) continue;
        const day = item.target.getAttribute("data-day");
        if (day && Math.abs((heights.current.get(day) ?? 0) - item.contentRect.height) > 1) {
          if (!changed) captureRecordedAnchor();
          heights.current.set(day, item.contentRect.height);
          changed = true;
        }
      }
      if (changed) setHeightVersion((value) => value + 1);
    });
    timelineRef.current?.querySelectorAll<HTMLElement>("[data-day]").forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [visible.map((group) => group.day).join("|")]);

  if (!groups.length) return <main className="reading-page reading-page-empty"><h1 className="visually-hidden">DIARY</h1><p className="reading-status">NO PUBLISHED ENTRIES</p></main>;
  const omittedHeight = (items: typeof groups) => items.reduce((total, item) => total + (heights.current.get(item.day) ?? Math.max(180, item.entries.length * 110)), 0);
  return <main className="reading-page" ref={timelineRef}>
    <h1 className="visually-hidden">DIARY</h1>
    {start ? <div aria-hidden="true" data-testid="top-window-spacer" style={{ height: omittedHeight(groups.slice(0, start)) }} /> : null}
    <div ref={topSentinel} aria-hidden="true" data-testid="top-window-sentinel" style={{ height: 1 }} />
    {visible.map(({ day, entries: dayEntries }) => <section className="day" id={`day-${day}`} key={day} data-day={day} data-testid={`day-${day}`} tabIndex={-1}>
      <header className="day-heading"><strong>{day.slice(-2)}</strong><span>{formatEnglishDayMeta(day, dayEntries.length)}</span></header>
      {dayEntries.map((entry) => <EntryBody entry={entry} key={entry.id} onEdit={onEditEntry} onTrash={onTrashEntry} player={player} />)}
    </section>)}
    <div ref={bottomSentinel} aria-hidden="true" data-testid="bottom-window-sentinel" style={{ height: 1 }} />
    {end < groups.length ? <div aria-hidden="true" data-testid="bottom-window-spacer" style={{ height: omittedHeight(groups.slice(end)) }} /> : null}
  </main>;
}
