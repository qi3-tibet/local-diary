import type { Entry } from "@diary/contracts";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PlayerStore } from "../music/player-store";
import { EntryBody } from "./EntryBody";
import { formatEnglishDayMeta, groupEntriesByBeijingDay } from "./date-groups";

type Props = {
  entries: Entry[];
  activeDay?: string;
  totalEntriesByDay?: Record<string, number>;
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
const MAX_VISIBLE_DAYS = SIDE_DAYS * 2 + 1;
const MAX_VISIBLE_ENTRIES = 200;
const MAX_TRAIL_BOUNDARIES = 80;

type WindowBoundary = {
  first: string;
  last: string;
};

/** Keeps both day sections and entry articles bounded across sparse and dense diaries. */
export function WindowedTimeline({
  entries,
  activeDay,
  totalEntriesByDay,
  onActiveDayChange,
  onEditEntry,
  onTrashEntry,
  player,
  onNeedOlder,
  onNeedNewer,
  preserveAnchor = true,
  pagingEnabled = true,
  navigationResetKey = 0,
}: Props) {
  const allGroups = useMemo(() => groupEntriesByBeijingDay(entries), [entries]);
  const orderedEntries = useMemo(
    () => allGroups.flatMap((group) => group.entries),
    [allGroups],
  );
  const entryDay = useMemo(
    () => new Map(allGroups.flatMap((group) => group.entries.map((entry) => [entry.id, group.day] as const))),
    [allGroups],
  );
  const entrySignature = orderedEntries.map((entry) => entry.id).join("|");
  const maximumStart = lastWindowStart(orderedEntries, entryDay);
  const [windowStart, setWindowStart] = useState(() =>
    centeredStart(orderedEntries, entryDay, activeDay, maximumStart),
  );
  const start = Math.min(Math.max(0, windowStart), maximumStart);
  const end = windowEnd(orderedEntries, entryDay, start);
  const visibleEntries = orderedEntries.slice(start, end);
  const visibleGroups = groupEntriesByBeijingDay(visibleEntries);
  const timelineRef = useRef<HTMLElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const needOlder = useRef(onNeedOlder);
  const needNewer = useRef(onNeedNewer);
  const heights = useRef(new Map<string, number>());
  const [heightVersion, setHeightVersion] = useState(0);
  const scrollDirection = useRef<"up" | "down" | null>(null);
  const lastScrollY = useRef(typeof window === "undefined" ? 0 : window.scrollY);
  const anchor = useRef<{ entryId: string; top: number } | undefined>(undefined);
  const positions = useRef(new Map<string, number>());
  const internalActiveDay = useRef<string | undefined>(undefined);
  const external = useRef<{ signature: string; day: string | undefined } | undefined>(undefined);
  const animationFrame = useRef<number | undefined>(undefined);
  const compensatingScroll = useRef(false);
  const scrollCompensation = useRef<{
    frame: number;
    previousBehavior: string;
    expectedScrollY: number;
    lastObservedScrollY: number;
    stableFrames: number;
  } | undefined>(undefined);
  const lastBoundary = useRef<string | undefined>(undefined);
  const boundaryArmed = useRef({ top: true, bottom: true });
  const trail = useRef<WindowBoundary[]>([]);
  const trailIndex = useRef(-1);
  const pendingLoads = useRef<Partial<Record<"top" | "bottom", {
    signature: string;
    cachedFirst?: string;
    cachedLast?: string;
    visibleFirst?: string;
    visibleLast?: string;
    visibleCount: number;
  }>>>({});
  const previousNavigationResetKey = useRef(navigationResetKey);
  const timelineState = useRef({
    start,
    end,
    count: orderedEntries.length,
    cachedFirst: orderedEntries[0]?.id,
    cachedLast: orderedEntries.at(-1)?.id,
    visibleFirst: visibleEntries[0]?.id,
    visibleLast: visibleEntries.at(-1)?.id,
    pagingEnabled,
  });
  timelineState.current = {
    start,
    end,
    count: orderedEntries.length,
    cachedFirst: orderedEntries[0]?.id,
    cachedLast: orderedEntries.at(-1)?.id,
    visibleFirst: visibleEntries[0]?.id,
    visibleLast: visibleEntries.at(-1)?.id,
    pagingEnabled,
  };
  needOlder.current = onNeedOlder;
  needNewer.current = onNeedNewer;

  useEffect(() => {
    if (previousNavigationResetKey.current === navigationResetKey) return;
    previousNavigationResetKey.current = navigationResetKey;
    lastBoundary.current = undefined;
    boundaryArmed.current = { top: true, bottom: true };
    pendingLoads.current = {};
    trail.current = [];
    trailIndex.current = -1;
  }, [navigationResetKey]);

  useEffect(() => {
    const cachedIds = new Set(orderedEntries.map((entry) => entry.id));
    for (const entryId of heights.current.keys()) {
      if (!cachedIds.has(entryId)) heights.current.delete(entryId);
    }
    for (const entryId of positions.current.keys()) {
      if (!cachedIds.has(entryId)) positions.current.delete(entryId);
    }
  }, [entrySignature, orderedEntries]);

  useEffect(() => {
    const changed = external.current?.signature !== entrySignature
      || external.current?.day !== activeDay;
    external.current = { signature: entrySignature, day: activeDay };
    if (!changed || activeDay === internalActiveDay.current) {
      internalActiveDay.current = undefined;
      return;
    }
    const activeIndex = orderedEntries.findIndex((entry) => entryDay.get(entry.id) === activeDay);
    if (activeIndex < start || activeIndex >= end) {
      lastBoundary.current = undefined;
      trail.current = [];
      trailIndex.current = -1;
      setWindowStart(centeredStart(orderedEntries, entryDay, activeDay, maximumStart));
    }
  }, [activeDay, end, entryDay, entrySignature, maximumStart, orderedEntries, start]);

  function recordPositions(): void {
    timelineRef.current?.querySelectorAll<HTMLElement>("[data-entry-id]").forEach((article) => {
      const entryId = article.dataset.entryId;
      if (entryId) positions.current.set(entryId, article.getBoundingClientRect().top);
    });
  }

  function finishScrollCompensation(): void {
    const pending = scrollCompensation.current;
    if (!pending) return;
    window.cancelAnimationFrame(pending.frame);
    document.documentElement.style.scrollBehavior = pending.previousBehavior;
    scrollCompensation.current = undefined;
    compensatingScroll.current = false;
  }

  function compensateScroll(delta: number): void {
    const existing = scrollCompensation.current;
    if (existing) window.cancelAnimationFrame(existing.frame);
    const root = document.documentElement;
    const previousBehavior = existing?.previousBehavior ?? root.style.scrollBehavior;
    const expectedScrollY = window.scrollY + delta;
    root.style.scrollBehavior = "auto";
    compensatingScroll.current = true;
    window.scrollBy(0, delta);
    lastScrollY.current = window.scrollY;
    const pending = {
      frame: 0,
      previousBehavior,
      expectedScrollY,
      lastObservedScrollY: window.scrollY,
      stableFrames: 0,
    };
    const observeAppliedScroll = () => {
      if (scrollCompensation.current !== pending) return;
      const nextScrollY = window.scrollY;
      pending.stableFrames = Math.abs(nextScrollY - pending.lastObservedScrollY) < 0.5
        ? pending.stableFrames + 1
        : 0;
      pending.lastObservedScrollY = nextScrollY;
      if (
        Math.abs(nextScrollY - pending.expectedScrollY) < 1
        || pending.stableFrames >= 4
      ) {
        finishScrollCompensation();
      } else {
        pending.frame = window.requestAnimationFrame(observeAppliedScroll);
      }
    };
    pending.frame = window.requestAnimationFrame(observeAppliedScroll);
    scrollCompensation.current = pending;
  }

  function captureAnchor(): void {
    const articles = [...(timelineRef.current?.querySelectorAll<HTMLElement>("[data-entry-id]") ?? [])];
    const nearest = articles.sort(
      (left, right) => Math.abs(left.getBoundingClientRect().top) - Math.abs(right.getBoundingClientRect().top),
    )[0];
    if (nearest?.dataset.entryId) {
      anchor.current = {
        entryId: nearest.dataset.entryId,
        top: nearest.getBoundingClientRect().top,
      };
    }
  }

  function captureRecordedAnchor(): void {
    const nearest = [...(timelineRef.current?.querySelectorAll<HTMLElement>("[data-entry-id]") ?? [])]
      .map((article) => ({
        entryId: article.dataset.entryId!,
        top: positions.current.get(article.dataset.entryId!),
      }))
      .filter((candidate): candidate is { entryId: string; top: number } => candidate.top !== undefined)
      .sort((left, right) => Math.abs(left.top) - Math.abs(right.top))[0];
    if (nearest) anchor.current = nearest;
  }

  function announceWindow(next: number): void {
    const nextEnd = windowEnd(orderedEntries, entryDay, next);
    const center = next + Math.floor((nextEnd - next) / 2);
    const day = entryDay.get(orderedEntries[Math.min(orderedEntries.length - 1, center)]?.id ?? "");
    if (!day) return;
    internalActiveDay.current = day;
    queueMicrotask(() => onActiveDayChange?.(day));
  }

  function boundaryAt(next: number): WindowBoundary | undefined {
    const nextEnd = windowEnd(orderedEntries, entryDay, next);
    const first = orderedEntries[next]?.id;
    const last = orderedEntries[nextEnd - 1]?.id;
    return first && last ? { first, last } : undefined;
  }

  function currentBoundary(): WindowBoundary | undefined {
    const current = timelineState.current;
    return current.visibleFirst && current.visibleLast
      ? { first: current.visibleFirst, last: current.visibleLast }
      : undefined;
  }

  function sameBoundary(left: WindowBoundary | undefined, right: WindowBoundary | undefined): boolean {
    return Boolean(left && right && left.first === right.first && left.last === right.last);
  }

  function ensureCurrentTrailBoundary(): void {
    const current = currentBoundary();
    if (!current) return;
    if (sameBoundary(trail.current[trailIndex.current], current)) return;
    const existing = trail.current.findIndex((item) => sameBoundary(item, current));
    if (existing >= 0) {
      trailIndex.current = existing;
      return;
    }
    trail.current = [current];
    trailIndex.current = 0;
  }

  function cachedBoundaryStart(boundary: WindowBoundary | undefined): number {
    if (!boundary) return -1;
    const next = orderedEntries.findIndex((entry) => entry.id === boundary.first);
    if (next < 0) return -1;
    const nextEnd = windowEnd(orderedEntries, entryDay, next);
    return orderedEntries[nextEnd - 1]?.id === boundary.last ? next : -1;
  }

  function rememberNewBoundary(
    direction: -1 | 1,
    boundary: WindowBoundary | undefined,
    ensureCurrent = true,
  ): void {
    if (!boundary) return;
    if (ensureCurrent) ensureCurrentTrailBoundary();
    if (direction === 1) {
      trail.current.splice(trailIndex.current + 1);
      trail.current.push(boundary);
      trailIndex.current = trail.current.length - 1;
      if (trail.current.length > MAX_TRAIL_BOUNDARIES) {
        trail.current.shift();
        trailIndex.current -= 1;
      }
    } else {
      trail.current.splice(0, trailIndex.current);
      trail.current.unshift(boundary);
      trailIndex.current = 0;
      if (trail.current.length > MAX_TRAIL_BOUNDARIES) trail.current.pop();
    }
  }

  function shiftWindow(direction: -1 | 1): void {
    captureAnchor();
    ensureCurrentTrailBoundary();
    const replayIndex = trailIndex.current + direction;
    const replayStart = cachedBoundaryStart(trail.current[replayIndex]);
    if (replayStart >= 0) {
      trailIndex.current = replayIndex;
      setWindowStart(replayStart);
      announceWindow(replayStart);
      return;
    }
    setWindowStart((current) => {
      const normalized = Math.min(Math.max(0, current), maximumStart);
      const currentEnd = windowEnd(orderedEntries, entryDay, normalized);
      const step = Math.max(1, Math.floor((currentEnd - normalized) / 2));
      const next = Math.min(maximumStart, Math.max(0, normalized + direction * step));
      rememberNewBoundary(direction, boundaryAt(next));
      announceWindow(next);
      return next;
    });
  }

  const shiftWindowRef = useRef(shiftWindow);
  shiftWindowRef.current = shiftWindow;

  useLayoutEffect(() => {
    for (const side of ["top", "bottom"] as const) {
      const pending = pendingLoads.current[side];
      if (!pending || pending.signature === entrySignature) continue;
      delete pendingLoads.current[side];
      lastBoundary.current = undefined;
      external.current = { signature: entrySignature, day: activeDay };
      const boundaryId = side === "top" ? pending.visibleFirst : pending.visibleLast;
      const pendingBoundary = pending.visibleFirst && pending.visibleLast
        ? { first: pending.visibleFirst, last: pending.visibleLast }
        : undefined;
      const pendingTrailIndex = trail.current.findIndex((item) => sameBoundary(item, pendingBoundary));
      if (pendingTrailIndex >= 0) {
        trailIndex.current = pendingTrailIndex;
      } else if (pendingBoundary) {
        trail.current = [pendingBoundary];
        trailIndex.current = 0;
      }
      const direction = side === "top" ? -1 : 1;
      const replayIndex = trailIndex.current + direction;
      const replayStart = cachedBoundaryStart(trail.current[replayIndex]);
      const boundaryIndex = boundaryId ? orderedEntries.findIndex((entry) => entry.id === boundaryId) : -1;
      if (replayStart < 0 && boundaryIndex < 0) continue;
      const next = replayStart >= 0
        ? replayStart
        : Math.min(
            maximumStart,
            Math.max(0, boundaryIndex - Math.floor(pending.visibleCount / 2)),
          );
      if (replayStart >= 0) trailIndex.current = replayIndex;
      else rememberNewBoundary(direction, boundaryAt(next), false);
      setWindowStart(next);
      announceWindow(next);
    }
  }, [entryDay, entrySignature, maximumStart, orderedEntries]);

  useLayoutEffect(() => {
    const saved = anchor.current;
    if (!preserveAnchor) {
      anchor.current = undefined;
    } else if (saved) {
      const node = timelineRef.current?.querySelector<HTMLElement>(
        `[data-entry-id="${CSS.escape(saved.entryId)}"]`,
      );
      if (node) {
        const delta = node.getBoundingClientRect().top - saved.top;
        if (Math.abs(delta) > 1) compensateScroll(delta);
        anchor.current = { entryId: saved.entryId, top: node.getBoundingClientRect().top };
      }
    }
    recordPositions();
  }, [entrySignature, heightVersion, preserveAnchor, start]);

  useEffect(() => {
    const trackDirection = () => {
      if (animationFrame.current !== undefined) return;
      animationFrame.current = window.requestAnimationFrame(() => {
        animationFrame.current = undefined;
        const nextScrollY = window.scrollY;
        if (compensatingScroll.current) {
          lastScrollY.current = nextScrollY;
          recordPositions();
          return;
        }
        if (nextScrollY !== lastScrollY.current) {
          const direction = nextScrollY > lastScrollY.current ? "down" : "up";
          if (scrollDirection.current && direction !== scrollDirection.current) {
            lastBoundary.current = undefined;
          }
          scrollDirection.current = direction;
          const current = timelineState.current;
          const topBounds = topSentinel.current?.getBoundingClientRect();
          const bottomBounds = bottomSentinel.current?.getBoundingClientRect();
          const isNear = (bounds?: DOMRect) =>
            Boolean(bounds && bounds.bottom >= -400 && bounds.top <= window.innerHeight + 400);
          if (!isNear(topBounds)) boundaryArmed.current.top = true;
          if (!isNear(bottomBounds)) boundaryArmed.current.bottom = true;
          const side = direction === "down" ? "bottom" : "top";
          const bounds = side === "bottom" ? bottomBounds : topBounds;
          const key = `${side}:${side === "bottom" ? current.visibleLast : current.visibleFirst}:${current.count}`;
          if (
            current.pagingEnabled
            && isNear(bounds)
            && boundaryArmed.current[side]
            && lastBoundary.current !== key
          ) {
            boundaryArmed.current[side] = false;
            lastBoundary.current = key;
            if (side === "bottom" && current.end < current.count) {
              shiftWindowRef.current(1);
            } else if (side === "top" && current.start > 0) {
              shiftWindowRef.current(-1);
            } else if (!pendingLoads.current[side]) {
              captureAnchor();
              ensureCurrentTrailBoundary();
              pendingLoads.current[side] = {
                signature: entrySignature,
                cachedFirst: current.cachedFirst,
                cachedLast: current.cachedLast,
                visibleFirst: current.visibleFirst,
                visibleLast: current.visibleLast,
                visibleCount: current.end - current.start,
              };
              if (side === "bottom") needOlder.current?.();
              else needNewer.current?.();
            }
          }
        }
        lastScrollY.current = nextScrollY;
        recordPositions();
      });
    };
    window.addEventListener("scroll", trackDirection, { passive: true });
    return () => {
      window.removeEventListener("scroll", trackDirection);
      if (animationFrame.current !== undefined) window.cancelAnimationFrame(animationFrame.current);
    };
  }, [entrySignature]);

  useEffect(() => () => finishScrollCompensation(), []);

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
  }, [onActiveDayChange, visibleGroups.map((group) => group.day).join("|")]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((observations) => {
      let changed = false;
      for (const item of observations) {
        if (!timelineRef.current?.contains(item.target)) continue;
        const entryId = (item.target as HTMLElement).dataset.entryId;
        if (entryId && Math.abs((heights.current.get(entryId) ?? 0) - item.contentRect.height) > 1) {
          if (!changed) captureRecordedAnchor();
          heights.current.set(entryId, item.contentRect.height);
          changed = true;
        }
      }
      if (changed) setHeightVersion((value) => value + 1);
    });
    timelineRef.current?.querySelectorAll<HTMLElement>("[data-entry-id]").forEach((article) => observer.observe(article));
    return () => observer.disconnect();
  }, [visibleEntries.map((entry) => entry.id).join("|")]);

  if (!orderedEntries.length) {
    return <main className="reading-page reading-page-empty" data-cached-entry-count="0"><h1 className="visually-hidden">DIARY</h1><p className="reading-status">NO PUBLISHED ENTRIES</p></main>;
  }
  const omittedHeight = (items: Entry[]) => {
    const days = new Set(items.map((entry) => entryDay.get(entry.id)).filter(Boolean));
    return items.reduce((total, entry) => total + (heights.current.get(entry.id) ?? 110), 0)
      + days.size * 70;
  };
  return (
    <main className="reading-page" ref={timelineRef} data-cached-entry-count={orderedEntries.length}>
      <h1 className="visually-hidden">DIARY</h1>
      {start ? <div aria-hidden="true" data-testid="top-window-spacer" style={{ height: omittedHeight(orderedEntries.slice(0, start)) }} /> : null}
      <div ref={topSentinel} aria-hidden="true" data-testid="top-window-sentinel" style={{ height: 1 }} />
      {visibleGroups.map(({ day, entries: dayEntries }) => (
        <section className="day" id={`day-${day}`} key={day} data-day={day} data-testid={`day-${day}`} tabIndex={-1}>
          <header className="day-heading">
            <strong>{day.slice(-2)}</strong>
            <span>{formatEnglishDayMeta(day, totalEntriesByDay?.[day] ?? allGroups.find((group) => group.day === day)?.entries.length ?? dayEntries.length)}</span>
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
      <div ref={bottomSentinel} aria-hidden="true" data-testid="bottom-window-sentinel" style={{ height: 1 }} />
      {end < orderedEntries.length ? <div aria-hidden="true" data-testid="bottom-window-spacer" style={{ height: omittedHeight(orderedEntries.slice(end)) }} /> : null}
    </main>
  );
}

function windowEnd(
  entries: Entry[],
  entryDay: Map<string, string>,
  start: number,
): number {
  const days = new Set<string>();
  let end = start;
  while (end < entries.length && end - start < MAX_VISIBLE_ENTRIES) {
    const day = entryDay.get(entries[end]!.id);
    if (day && !days.has(day) && days.size >= MAX_VISIBLE_DAYS) break;
    if (day) days.add(day);
    end += 1;
  }
  return end;
}

function lastWindowStart(entries: Entry[], entryDay: Map<string, string>): number {
  const days = new Set<string>();
  let start = entries.length;
  while (start > 0 && entries.length - start < MAX_VISIBLE_ENTRIES) {
    const day = entryDay.get(entries[start - 1]!.id);
    if (day && !days.has(day) && days.size >= MAX_VISIBLE_DAYS) break;
    if (day) days.add(day);
    start -= 1;
  }
  return start;
}

function centeredStart(
  entries: Entry[],
  entryDay: Map<string, string>,
  activeDay: string | undefined,
  maximumStart: number,
): number {
  const activeIndex = entries.findIndex((entry) => entryDay.get(entry.id) === activeDay);
  if (activeIndex < 0) return 0;
  const days = new Set<string>();
  let start = activeIndex;
  while (start > 0) {
    const previousDay = entryDay.get(entries[start - 1]!.id);
    if (previousDay && !days.has(previousDay) && days.size >= SIDE_DAYS) break;
    if (previousDay) days.add(previousDay);
    start -= 1;
  }
  return Math.min(maximumStart, start);
}
