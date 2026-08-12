// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Entry } from "@diary/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const timelineProps = vi.hoisted(() => vi.fn());
const dateRailProps = vi.hoisted(() => vi.fn());
const searchProps = vi.hoisted(() => vi.fn());
const editorProps = vi.hoisted(() => vi.fn());
const listDayPage = vi.hoisted(() => vi.fn());
const listCalendarDays = vi.hoisted(() => vi.fn());
const getDraft = vi.hoisted(() => vi.fn<() => Promise<Entry | null>>(async () => null));
const renderTimelineSections = vi.hoisted(() => ({ value: false }));
const targetEntry = vi.hoisted(() => ({
  id: "00000000-0000-4000-8000-000000000001",
  title: "Target",
  markdown: "Target body",
  state: "published",
  publishedAt: "2025-07-26T10:00:00.000+08:00",
  createdAt: "2025-07-26T10:00:00.000+08:00",
  updatedAt: "2025-07-26T10:00:00.000+08:00",
  deletedAt: null,
  edited: false,
  tags: [],
  music: null,
} satisfies Entry));

vi.mock("../api/client", () => ({
  api: {
    listDayPage,
    listCalendarDays,
    getDraft,
  },
}));
vi.mock("../diary/WindowedTimeline", () => ({
  WindowedTimeline: (props: {
    activeDay?: string;
    entries: Entry[];
    pagingEnabled: boolean;
    navigationResetKey: number;
    onNeedOlder: () => void;
  }) => {
    timelineProps(props);
    const days = [...new Set(props.entries.map((entry) => entry.publishedAt?.slice(0, 10)).filter(Boolean))];
    return (
      <main data-testid="timeline">
        {renderTimelineSections.value
          ? days.map((day) => (
              <section id={`day-${day}`} key={day} tabIndex={-1}>
                {props.entries
                  .filter((entry) => entry.publishedAt?.slice(0, 10) === day)
                  .map((entry) => <article data-entry-id={entry.id} key={entry.id} tabIndex={-1} />)}
              </section>
            ))
          : null}
      </main>
    );
  },
}));
vi.mock("../diary/DateRail", () => ({
  DateRail: (props: { onJumpDay: (day: string) => void }) => {
    dateRailProps(props);
    return <aside />;
  },
}));
vi.mock("../search/SearchPanel", () => ({
  SearchPanel: (props: { onOpen: (entry: Entry) => void }) => {
    searchProps(props);
    return <div data-testid="search-panel" />;
  },
}));
vi.mock("../editor/Editor", () => ({
  Editor: (props: { entry?: Entry; onComplete: (entry: Entry) => void }) => {
    editorProps(props);
    return <div data-testid="editor" />;
  },
}));
vi.mock("../music/FloatingPlayer", () => ({ FloatingPlayer: () => null }));
vi.mock("../settings/BackupSettings", () => ({ BackupSettings: () => null }));
vi.mock("../settings/RestoreProgress", () => ({ RestoreProgress: () => null }));
vi.mock("../theme/ThemeControl", () => ({ ThemeControl: () => null }));

import { App } from "./App";

describe("App programmatic day navigation", () => {
  beforeEach(() => {
    timelineProps.mockClear();
    dateRailProps.mockClear();
    searchProps.mockClear();
    editorProps.mockClear();
    listDayPage.mockReset();
    listCalendarDays.mockReset();
    getDraft.mockReset();
    getDraft.mockResolvedValue(null);
    listCalendarDays.mockResolvedValue(["2025-07-26", "2025-07-25"]);
    listDayPage.mockResolvedValue({
      days: [{ day: "2025-07-26", totalEntries: 1, entries: [targetEntry] }],
      previousCursor: "newer",
      nextCursor: "older",
    });
    renderTimelineSections.value = false;
    window.history.replaceState({}, "", "/?day=2025-07-26");
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("locks paging and resets the timeline before rendering an initial URL day jump", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    await screen.findByTestId("timeline");
    await waitFor(() => expect(timelineProps).toHaveBeenCalled());
    const first = timelineProps.mock.calls[0]?.[0] as {
      pagingEnabled: boolean;
      navigationResetKey: number;
    };
    expect(first.pagingEnabled).toBe(false);
    expect(first.navigationResetKey).toBeGreaterThan(0);
  });

  it("keeps the timeline open when a saved draft exists at startup", async () => {
    window.history.replaceState({}, "", "/");
    getDraft.mockResolvedValue({ ...targetEntry, state: "draft", publishedAt: null });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

    await screen.findByTestId("timeline");
    await waitFor(() => expect(getDraft).toHaveBeenCalled());
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
  });

  it("keeps retrying the locked jump when its section mounts after the first animation frame", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
      frames.delete(id);
    }));
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );
    render(tree);

    await screen.findByTestId("timeline");
    await waitFor(() => expect(frames.size).toBeGreaterThan(0));
    const firstFrame = [...frames.entries()][0]!;
    frames.delete(firstFrame[0]);
    act(() => firstFrame[1](0));
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(frames.size).toBeGreaterThan(0);

    const target = document.createElement("section");
    target.id = "day-2025-07-26";
    target.tabIndex = -1;
    screen.getByTestId("timeline").append(target);
    const retryFrame = [...frames.entries()][0]!;
    frames.delete(retryFrame[0]);
    act(() => retryFrame[1](16));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    expect(document.activeElement).toBe(target);
    const latest = timelineProps.mock.calls.at(-1)?.[0] as { pagingEnabled: boolean };
    expect(latest.pagingEnabled).toBe(false);
  });

  it("centers and finally focuses search navigation on the exact entry element", async () => {
    window.history.replaceState({}, "", "/");
    renderTimelineSections.value = true;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
      frames.delete(id);
    }));
    const scrolled: HTMLElement[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) {
        scrolled.push(this);
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByTestId("timeline");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByTestId("search-panel");
    act(() => searchProps.mock.calls.at(-1)![0].onOpen(targetEntry));
    await waitFor(() => expect(listDayPage).toHaveBeenLastCalledWith({ entryId: targetEntry.id }));
    await waitFor(() => expect(frames.size).toBeGreaterThan(0));
    const scrollFrame = [...frames.entries()][0]!;
    frames.delete(scrollFrame[0]);
    act(() => scrollFrame[1](0));
    const target = document.querySelector<HTMLElement>(`[data-entry-id="${targetEntry.id}"]`)!;
    expect(scrolled).toEqual([target]);
    expect(document.activeElement).toBe(target);
  });

  it("locks paging as soon as a day navigation request begins", async () => {
    window.history.replaceState({}, "", "/");
    let resolveJump!: (page: unknown) => void;
    const jump = new Promise((resolve) => { resolveJump = resolve; });
    listDayPage
      .mockResolvedValueOnce({
        days: [{ day: "2025-07-26", totalEntries: 1, entries: [targetEntry] }],
        previousCursor: "newer",
        nextCursor: "older",
      })
      .mockImplementationOnce(() => jump);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
    await screen.findByTestId("timeline");
    act(() => dateRailProps.mock.calls.at(-1)![0].onJumpDay("2025-07-25"));
    await waitFor(() => expect(listDayPage).toHaveBeenCalledTimes(2));
    const pending = timelineProps.mock.calls.at(-1)![0] as {
      pagingEnabled: boolean;
      onNeedOlder: () => void;
    };
    expect(pending.pagingEnabled).toBe(false);
    act(() => pending.onNeedOlder());
    expect(listDayPage).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveJump({
        days: [{ day: "2025-07-25", totalEntries: 1, entries: [{ ...targetEntry, publishedAt: "2025-07-25T10:00:00.000+08:00" }] }],
        previousCursor: "jump-newer",
        nextCursor: "jump-older",
      });
      await jump;
    });
  });

  it("returns from editing to the exact saved entry instead of the newest page", async () => {
    window.history.replaceState({}, "", "/");
    renderTimelineSections.value = true;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByTestId("timeline");

    act(() => timelineProps.mock.calls.at(-1)![0].onEditEntry(targetEntry));
    await screen.findByTestId("editor");
    expect(editorProps.mock.calls.at(-1)![0].entry).toEqual(targetEntry);

    const savedEntry = { ...targetEntry, markdown: "Updated body", edited: true };
    act(() => editorProps.mock.calls.at(-1)![0].onComplete(savedEntry));

    await screen.findByTestId("timeline");
    await waitFor(() => expect(listDayPage).toHaveBeenLastCalledWith({ entryId: targetEntry.id }));
    await waitFor(() => {
      const latest = timelineProps.mock.calls.at(-1)![0] as {
        activeDay?: string;
        pagingEnabled: boolean;
      };
      expect(latest.activeDay).toBe("2025-07-26");
      expect(latest.pagingEnabled).toBe(false);
    });
  });

  it("jumps within cached dates without replacing the timeline with the newest page", async () => {
    window.history.replaceState({}, "", "/");
    const older = {
      ...targetEntry,
      id: "00000000-0000-4000-8000-000000000002",
      publishedAt: "2025-07-25T10:00:00.000+08:00",
    };
    listDayPage.mockResolvedValueOnce({
      days: [
        { day: "2025-07-26", totalEntries: 1, entries: [targetEntry] },
        { day: "2025-07-25", totalEntries: 1, entries: [older] },
      ],
      previousCursor: null,
      nextCursor: null,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
    await screen.findByTestId("timeline");

    act(() => dateRailProps.mock.calls.at(-1)![0].onJumpDay("2025-07-25"));

    await waitFor(() => {
      const latest = timelineProps.mock.calls.at(-1)![0] as { activeDay?: string };
      expect(latest.activeDay).toBe("2025-07-25");
    });
    expect(listDayPage).toHaveBeenCalledTimes(1);
  });

  it("releases the paging lock and reports a failed day navigation", async () => {
    window.history.replaceState({}, "", "/");
    listDayPage
      .mockResolvedValueOnce({
        days: [{ day: "2025-07-26", totalEntries: 1, entries: [targetEntry] }],
        previousCursor: "newer",
        nextCursor: "older",
      })
      .mockRejectedValueOnce(new Error("offline"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
    await screen.findByTestId("timeline");
    act(() => dateRailProps.mock.calls.at(-1)![0].onJumpDay("2025-07-25"));
    expect(await screen.findByRole("alert")).toHaveTextContent("THE DATE COULD NOT BE OPENED");
    await waitFor(() => {
      expect(timelineProps.mock.calls.at(-1)![0].pagingEnabled).toBe(true);
    });
  });

  it("releases the paging lock and reports a failed search navigation", async () => {
    window.history.replaceState({}, "", "/");
    listDayPage
      .mockResolvedValueOnce({
        days: [{ day: "2025-07-26", totalEntries: 1, entries: [targetEntry] }],
        previousCursor: "newer",
        nextCursor: "older",
      })
      .mockRejectedValueOnce(new Error("offline"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
    await screen.findByTestId("timeline");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByTestId("search-panel");
    act(() => searchProps.mock.calls.at(-1)![0].onOpen(targetEntry));
    expect(await screen.findByRole("alert")).toHaveTextContent("THE ENTRY COULD NOT BE OPENED");
    await waitFor(() => {
      expect(timelineProps.mock.calls.at(-1)![0].pagingEnabled).toBe(true);
    });
  });

  it("discards an older page response that resolves after a day navigation", async () => {
    window.history.replaceState({}, "", "/");
    const staleEntry = { ...targetEntry, id: "00000000-0000-4000-8000-000000000002", publishedAt: "2025-07-20T10:00:00.000+08:00" };
    const jumpedEntry = { ...targetEntry, id: "00000000-0000-4000-8000-000000000003", publishedAt: "2025-07-25T10:00:00.000+08:00" };
    let resolveOlder!: (page: unknown) => void;
    const older = new Promise((resolve) => { resolveOlder = resolve; });
    listDayPage
      .mockResolvedValueOnce({
        days: [{ day: "2025-07-26", totalEntries: 1, entries: [targetEntry] }],
        previousCursor: "newer",
        nextCursor: "older",
      })
      .mockImplementationOnce(() => older)
      .mockResolvedValueOnce({
        days: [{ day: "2025-07-25", totalEntries: 1, entries: [jumpedEntry] }],
        previousCursor: "jump-newer",
        nextCursor: "jump-older",
      });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
    await screen.findByTestId("timeline");
    act(() => timelineProps.mock.calls.at(-1)![0].onNeedOlder());
    await waitFor(() => expect(listDayPage).toHaveBeenCalledTimes(2));
    act(() => dateRailProps.mock.calls.at(-1)![0].onJumpDay("2025-07-25"));
    await waitFor(() => expect(listDayPage).toHaveBeenCalledTimes(3));
    await act(async () => {
      resolveOlder({
        days: [{ day: "2025-07-20", totalEntries: 1, entries: [staleEntry] }],
        previousCursor: "stale-newer",
        nextCursor: "stale-older",
      });
      await older;
      await Promise.resolve();
    });
    await waitFor(() => {
      const entries = timelineProps.mock.calls.at(-1)![0].entries as Entry[];
      expect(entries.map((entry) => entry.id)).toEqual([jumpedEntry.id]);
    });
  });

  it("unlocks an empty requested day onto the nearest returned day", async () => {
    window.history.replaceState({}, "", "/");
    renderTimelineSections.value = true;
    const nearest = { ...targetEntry, publishedAt: "2025-07-25T10:00:00.000+08:00" };
    listDayPage
      .mockResolvedValueOnce({
        days: [{ day: "2025-07-26", totalEntries: 1, entries: [targetEntry] }],
        previousCursor: "newer",
        nextCursor: "older",
      })
      .mockResolvedValueOnce({
        days: [{ day: "2025-07-25", totalEntries: 1, entries: [nearest] }],
        previousCursor: "newer",
        nextCursor: "older",
      });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
    await screen.findByTestId("timeline");
    act(() => dateRailProps.mock.calls.at(-1)![0].onJumpDay("2025-07-24"));
    await waitFor(() => {
      const latest = timelineProps.mock.calls.at(-1)![0] as { activeDay?: string; pagingEnabled: boolean };
      expect(latest.activeDay).toBe("2025-07-25");
      expect(latest.pagingEnabled).toBe(true);
    });
  });

  it("shows the initial query error instead of an endless opening state", async () => {
    window.history.replaceState({}, "", "/");
    listDayPage.mockRejectedValue(new Error("offline"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("THE DIARY COULD NOT BE OPENED");
  });
});
