// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "@diary/contracts";
import { WindowedTimeline } from "./WindowedTimeline";

type ObserverRecord = {
  callback: IntersectionObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  disconnected: boolean;
};

let intersections: ObserverRecord[] = [];
let resizes: Array<{ callback: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
let scrollPosition = 0;
let sentinelPositions = { top: 100, bottom: 100 };

class TestIntersectionObserver {
  callback: IntersectionObserverCallback;
  observe = vi.fn();
  disconnected = false;
  disconnect = vi.fn(() => {
    this.disconnected = true;
  });
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    intersections.push(this);
  }
  unobserve = vi.fn();
  takeRecords = vi.fn(() => []);
  root = null;
  rootMargin = "0px";
  thresholds = [0];
}

class TestResizeObserver {
  callback: ResizeObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizes.push(this);
  }
  unobserve = vi.fn();
}

function entry(day: number): Entry {
  const date = new Date(Date.UTC(2020, 6, 1 + day)).toISOString().slice(0, 10);
  return {
    id: `entry-${day}`,
    title: `Title ${day}`,
    markdown: `Body ${day}`,
    state: "published",
    publishedAt: `${date}T10:00:00.000+08:00`,
    createdAt: `${date}T10:00:00.000+08:00`,
    updatedAt: `${date}T10:00:00.000+08:00`,
    deletedAt: null,
    edited: false,
    tags: [],
    music: null,
  };
}

function denseEntry(index: number): Entry {
  const minute = Math.floor(index / 60);
  const second = index % 60;
  const timestamp = `2020-07-20T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000+08:00`;
  return {
    ...entry(19),
    id: `dense-${String(index).padStart(4, "0")}`,
    title: `Dense ${index}`,
    markdown: `Dense body ${index}`,
    publishedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function dayIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>("section[data-day]")].map((node) => node.id);
}

function entryIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>("article.entry")]
    .map((node) => node.dataset.entryId!);
}

function setScrollY(next: number): void {
  scrollPosition = next;
  act(() => {
    window.dispatchEvent(new Event("scroll"));
    vi.runAllTimers();
  });
}

function intersect(target: Element, isIntersecting = true): void {
  const observation = {
    target,
    isIntersecting,
    boundingClientRect: target.getBoundingClientRect(),
  } as IntersectionObserverEntry;
  act(() => intersections.filter((observer) => !observer.disconnected).forEach((observer) => observer.callback([observation], observer as unknown as IntersectionObserver)));
}

function resize(target: Element, height: number): void {
  const observation = { target, contentRect: { height } } as unknown as ResizeObserverEntry;
  act(() => resizes.forEach((observer) => observer.callback([observation], observer as unknown as ResizeObserver)));
}

describe("WindowedTimeline", () => {
  beforeEach(() => {
    intersections = [];
    resizes = [];
    scrollPosition = 0;
    sentinelPositions = { top: 100, bottom: 100 };
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollPosition });
    vi.stubGlobal("scrollBy", vi.fn());
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rect(this: HTMLElement) {
      const testId = this.dataset.testid;
      const top = testId === "top-window-sentinel"
        ? sentinelPositions.top
        : testId === "bottom-window-sentinel"
          ? sentinelPositions.bottom
          : 2000;
      return { x: 0, y: top, top, left: 0, right: 1, bottom: top + 1, width: 1, height: 1, toJSON: () => ({}) } as DOMRect;
    });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.style.scrollBehavior = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mounts only the active day plus seven day groups on either side", () => {
    render(<WindowedTimeline entries={Array.from({ length: 30 }, (_, day) => entry(day))} activeDay="2020-07-16" />);
    expect(screen.getByTestId("day-2020-07-16")).toBeInTheDocument();
    expect(document.querySelectorAll("article.entry")).toHaveLength(15);
    expect(document.querySelector("#day-2020-07-01")).not.toBeInTheDocument();
  });

  it("bounds a dense single-day window and traverses cached entries without duplicate sections", () => {
    const onNeedOlder = vi.fn();
    const entries = Array.from({ length: 300 }, (_, index) => denseEntry(index));
    render(
      <WindowedTimeline
        entries={entries}
        activeDay="2020-07-20"
        onNeedOlder={onNeedOlder}
      />,
    );
    const initialIds = [...document.querySelectorAll<HTMLElement>("article.entry")]
      .map((node) => node.dataset.entryId);
    expect(initialIds.length).toBeLessThan(250);
    expect(document.querySelectorAll("#day-2020-07-20")).toHaveLength(1);

    setScrollY(100);
    const nextIds = [...document.querySelectorAll<HTMLElement>("article.entry")]
      .map((node) => node.dataset.entryId);
    expect(nextIds).not.toEqual(initialIds);
    expect(new Set(nextIds).size).toBe(nextIds.length);
    expect(document.querySelectorAll("#day-2020-07-20")).toHaveLength(1);
    expect(onNeedOlder).not.toHaveBeenCalled();
  });

  it("keeps sentinels adjacent to the rendered window, between the spacers", () => {
    const entries = Array.from({ length: 40 }, (_, day) => entry(day));
    render(<WindowedTimeline entries={entries} activeDay="2020-07-20" />);
    expect(screen.getByTestId("day-2020-07-20")).toBeInTheDocument();
    const children = [...document.querySelector("main")!.children];
    const topSpacer = children.indexOf(screen.getByTestId("top-window-spacer"));
    const topSentinel = children.indexOf(screen.getByTestId("top-window-sentinel"));
    const bottomSentinel = children.indexOf(screen.getByTestId("bottom-window-sentinel"));
    const bottomSpacer = children.indexOf(screen.getByTestId("bottom-window-spacer"));
    expect(topSpacer).toBeLessThan(topSentinel);
    expect(topSentinel).toBeLessThan(children.findIndex((node) => node.matches("section[data-day]")));
    const lastSection = children.reduce((last, node, index) => node.matches("section[data-day]") ? index : last, -1);
    expect(bottomSentinel).toBeGreaterThan(lastSection);
    expect(bottomSentinel).toBeLessThan(bottomSpacer);
  });

  it("advances three overlapping windows, reverses them, and ignores an unchanged old active-day prop", async () => {
    const entries = Array.from({ length: 80 }, (_, day) => entry(day));
    const onActiveDayChange = vi.fn();
    const { rerender } = render(<WindowedTimeline entries={entries} activeDay="2020-08-10" onActiveDayChange={onActiveDayChange} />);
    expect(dayIds()).toHaveLength(15);
    const original = dayIds();
    const starts = [original[0]];

    for (let shift = 0; shift < 3; shift += 1) {
      setScrollY(scrollPosition + 100);
      expect(dayIds()[0]).not.toBe(starts.at(-1));
      starts.push(dayIds()[0]);
      // Repeating an event without movement cannot duplicate the transition.
      setScrollY(scrollPosition);
      expect(dayIds()[0]).toBe(starts.at(-1));
      sentinelPositions.bottom = 2000;
      setScrollY(scrollPosition + 1);
      sentinelPositions.bottom = 100;
    }
    expect(new Set(starts).size).toBe(4);
    const shifted = dayIds();
    // Parent still providing its former day while it processes the callback must
    // not pull the viewport back to that old window.
    rerender(<WindowedTimeline entries={entries} activeDay="2020-08-10" onActiveDayChange={onActiveDayChange} />);
    expect(dayIds()).toEqual(shifted);

    for (let shift = 0; shift < 3; shift += 1) {
      setScrollY(Math.max(0, scrollPosition - 100));
      expect(dayIds()[0]).toBe(starts[2 - shift]);
      setScrollY(scrollPosition);
      expect(dayIds()[0]).toBe(starts[2 - shift]);
      sentinelPositions.top = 2000;
      setScrollY(Math.max(0, scrollPosition - 1));
      sentinelPositions.top = 100;
    }
    expect(dayIds()).toEqual(original);
    await Promise.resolve();
    expect(onActiveDayChange).toHaveBeenCalled();
  });

  it("replays exact entry boundaries twice after a non-aligned window is prepended and cache-trimmed", () => {
    scrollPosition = 10_000;
    const onNeedNewer = vi.fn();
    const initialEntries = Array.from({ length: 360 }, (_, day) => entry(day));
    const activeDay = entry(320).publishedAt!.slice(0, 10);
    const { rerender } = render(
      <WindowedTimeline
        entries={initialEntries}
        activeDay={activeDay}
        onNeedNewer={onNeedNewer}
      />,
    );
    const original = entryIds();
    expect(original[0]).toBe("entry-327");

    for (let transition = 0; transition < 10 && !onNeedNewer.mock.calls.length; transition += 1) {
      setScrollY(scrollPosition - 100);
      sentinelPositions.top = 2000;
      setScrollY(scrollPosition - 1);
      sentinelPositions.top = 100;
    }
    expect(onNeedNewer).toHaveBeenCalledTimes(1);

    // A newer 120-entry page is prepended while the oldest 120 cached entries
    // are trimmed, keeping the cache at 360 entries.
    rerender(
      <WindowedTimeline
        entries={Array.from({ length: 360 }, (_, offset) => entry(offset + 120))}
        activeDay={activeDay}
        onNeedNewer={onNeedNewer}
      />,
    );

    const returnToOriginal = () => {
      const starts: string[] = [];
      for (let transition = 0; transition < 30; transition += 1) {
        if (entryIds().join("|") === original.join("|")) return true;
        starts.push(entryIds()[0]!);
        setScrollY(scrollPosition + 100);
        sentinelPositions.bottom = 2000;
        setScrollY(scrollPosition + 1);
        sentinelPositions.bottom = 100;
      }
      return entryIds().join("|") === original.join("|");
    };
    expect(returnToOriginal()).toBe(true);

    for (let transition = 0; transition < 30 && entryIds()[0] !== "entry-479"; transition += 1) {
      setScrollY(scrollPosition - 100);
      sentinelPositions.top = 2000;
      setScrollY(scrollPosition - 1);
      sentinelPositions.top = 100;
    }
    expect(returnToOriginal()).toBe(true);
  });

  it("moves into a page that arrives while its loaded-edge sentinel stays intersecting", () => {
    const onNeedOlder = vi.fn();
    const firstPage = Array.from({ length: 15 }, (_, day) => entry(day + 15));
    const { rerender } = render(
      <WindowedTimeline entries={firstPage} activeDay="2020-07-23" onNeedOlder={onNeedOlder} />,
    );
    const original = dayIds();
    setScrollY(100);
    expect(onNeedOlder).toHaveBeenCalledTimes(1);

    rerender(
      <WindowedTimeline
        entries={Array.from({ length: 30 }, (_, day) => entry(day))}
        activeDay="2020-07-23"
        onNeedOlder={onNeedOlder}
      />,
    );
    expect(dayIds()).not.toEqual(original);
    expect(dayIds()[0]).toBe("day-2020-07-23");
    expect(onNeedOlder).toHaveBeenCalledTimes(1);
  });

  it("preserves an old visible anchor when a newer loaded-edge page is prepended", () => {
    scrollPosition = 200;
    const onNeedNewer = vi.fn();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rect(this: HTMLElement) {
      if (this.dataset.testid?.endsWith("window-sentinel")) {
        return { x: 0, y: 100, top: 100, left: 0, right: 1, bottom: 101, width: 1, height: 1, toJSON: () => ({}) } as DOMRect;
      }
      const index = [...document.querySelectorAll("article.entry")].indexOf(this as HTMLElement);
      const top = index < 0 ? 2000 : 50 + index * 100;
      return { x: 0, y: top, top, left: 0, right: 100, bottom: top + 90, width: 100, height: 90, toJSON: () => ({}) } as DOMRect;
    });
    const firstPage = Array.from({ length: 15 }, (_, day) => entry(day));
    const { rerender } = render(
      <WindowedTimeline entries={firstPage} activeDay="2020-07-08" onNeedNewer={onNeedNewer} />,
    );
    setScrollY(100);
    expect(onNeedNewer).toHaveBeenCalledTimes(1);
    vi.mocked(window.scrollBy).mockClear();
    document.documentElement.style.scrollBehavior = "smooth";
    let behaviorAtScroll = "";
    vi.mocked(window.scrollBy).mockImplementation((_x, delta) => {
      behaviorAtScroll = document.documentElement.style.scrollBehavior;
      scrollPosition += Number(delta);
      window.dispatchEvent(new Event("scroll"));
    });

    rerender(
      <WindowedTimeline
        entries={Array.from({ length: 30 }, (_, day) => entry(day))}
        activeDay="2020-07-08"
        onNeedNewer={onNeedNewer}
      />,
    );

    expect(window.scrollBy).toHaveBeenCalled();
    expect(behaviorAtScroll).toBe("auto");
    expect(document.documentElement.style.scrollBehavior).toBe("auto");
    act(() => vi.runAllTimers());
    expect(document.documentElement.style.scrollBehavior).toBe("smooth");
    expect(onNeedNewer).toHaveBeenCalledTimes(1);
  });

  it("does not cascade into a page fetch when a clamped shift leaves scroll events near the same boundary", () => {
    const onNeedNewer = vi.fn();
    scrollPosition = 200;
    render(
      <WindowedTimeline
        entries={Array.from({ length: 18 }, (_, day) => entry(day))}
        activeDay="2020-07-01"
        onNeedNewer={onNeedNewer}
      />,
    );
    setScrollY(100);
    const shifted = dayIds();
    expect(shifted[0]).toBe("day-2020-07-18");

    setScrollY(90);
    expect(dayIds()).toEqual(shifted);
    expect(onNeedNewer).not.toHaveBeenCalled();
  });

  it("rearms boundary traversal for an external active-day jump inside the mounted window", () => {
    const entries = Array.from({ length: 40 }, (_, day) => entry(day));
    const { rerender } = render(
      <WindowedTimeline entries={entries} activeDay="2020-08-03" navigationResetKey={1} />,
    );
    setScrollY(100);
    const once = dayIds();

    rerender(<WindowedTimeline entries={entries} activeDay="2020-07-27" navigationResetKey={2} />);
    setScrollY(200);

    expect(dayIds()).not.toEqual(once);
  });

  it("disconnects observers and cancels a pending scroll frame on unmount", () => {
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    const { unmount } = render(
      <WindowedTimeline
        entries={Array.from({ length: 20 }, (_, day) => entry(day))}
        activeDay="2020-07-10"
        onActiveDayChange={() => undefined}
      />,
    );
    act(() => window.dispatchEvent(new Event("scroll")));
    const activeIntersection = intersections.at(-1)!;
    const activeResize = resizes.at(-1)!;

    unmount();

    expect(activeIntersection.disconnect).toHaveBeenCalledTimes(1);
    expect(activeResize.disconnect).toHaveBeenCalledTimes(1);
    expect(cancelFrame).toHaveBeenCalledTimes(1);
  });

  it("rerenders estimated spacers and corrects from the anchor recorded before ResizeObserver reports a change", () => {
    let moved = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rect(this: HTMLElement) {
      if (this.dataset.testid?.endsWith("window-sentinel")) {
        return { x: 0, y: 100, top: 100, left: 0, right: 1, bottom: 101, width: 1, height: 1, toJSON: () => ({}) } as DOMRect;
      }
      const index = [...document.querySelectorAll("article.entry")].indexOf(this as HTMLElement);
      const top = index < 0 ? 2000 : (index - 7) * 100 + moved;
      return { x: 0, y: top, top, left: 0, right: 100, bottom: top + 90, width: 100, height: 90, toJSON: () => ({}) } as DOMRect;
    });
    const entries = Array.from({ length: 55 }, (_, day) => entry(day));
    render(<WindowedTimeline entries={entries} activeDay="2020-07-20" />);
    const firstEntry = document.querySelector<HTMLElement>("article.entry")!;
    resize(firstEntry, 826);
    vi.mocked(window.scrollBy).mockClear();
    moved = 48;
    resize(firstEntry, 900);
    expect(window.scrollBy).toHaveBeenCalledWith(0, 48);
    act(() => vi.runAllTimers());

    // Moving the window now omits the measured day; the spacer uses its latest
    // measured height instead of the never-mounted-day fallback.
    setScrollY(100);
    expect(screen.getByTestId("top-window-spacer").style.height).toBe("7090px");
  });

  it("preserves a visible entry when an earlier entry body or image changes height", () => {
    let moved = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rect(this: HTMLElement) {
      if (this.dataset.testid?.endsWith("window-sentinel")) {
        return { x: 0, y: 100, top: 100, left: 0, right: 1, bottom: 101, width: 1, height: 1, toJSON: () => ({}) } as DOMRect;
      }
      const index = [...document.querySelectorAll("article.entry")].indexOf(this as HTMLElement);
      const top = index < 0 ? 2000 : (index - 7) * 100 + moved;
      return { x: 0, y: top, top, left: 0, right: 100, bottom: top + 90, width: 100, height: 90, toJSON: () => ({}) } as DOMRect;
    });
    render(
      <WindowedTimeline
        entries={Array.from({ length: 30 }, (_, day) => entry(day))}
        activeDay="2020-07-16"
      />,
    );
    const preceding = document.querySelector<HTMLElement>("article.entry")!;
    resize(preceding, 110);
    vi.mocked(window.scrollBy).mockClear();
    moved = 64;
    resize(preceding, 174);

    expect(window.scrollBy).toHaveBeenCalledWith(0, 64);
  });
});
