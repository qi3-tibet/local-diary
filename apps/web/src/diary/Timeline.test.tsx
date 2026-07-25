// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { Entry } from "@diary/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateRail } from "./DateRail";
import { Timeline } from "./Timeline";

const entriesForTwoDays: Entry[] = [
  {
    id: "evening-walk",
    title: "雨后的街道",
    markdown: "树叶上的水滴声",
    state: "published",
    publishedAt: "2026-07-26T20:18:00+08:00",
    createdAt: "2026-07-26T12:18:00.000Z",
    updatedAt: "2026-07-26T12:18:00.000Z",
    deletedAt: null,
    edited: false,
    tags: ["散步"],
  },
  {
    id: "morning-note",
    title: "清晨",
    markdown: "窗帘透进一线光。",
    state: "published",
    publishedAt: "2026-07-26T08:04:00+08:00",
    createdAt: "2026-07-26T00:04:00.000Z",
    updatedAt: "2026-07-26T00:04:00.000Z",
    deletedAt: null,
    edited: false,
    tags: [],
  },
  {
    id: "finished-book",
    title: "读书",
    markdown: "终于读完了这本书",
    state: "published",
    publishedAt: "2026-07-25T23:42:00+08:00",
    createdAt: "2026-07-25T15:42:00.000Z",
    updatedAt: "2026-07-25T15:42:00.000Z",
    deletedAt: null,
    edited: false,
    tags: ["阅读"],
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Timeline", () => {
  it("renders full bodies across days without rendering entry titles", () => {
    render(<Timeline entries={entriesForTwoDays} />);

    expect(screen.getByText("树叶上的水滴声")).toBeVisible();
    expect(screen.getByText("终于读完了这本书")).toBeVisible();
    expect(screen.queryByText("雨后的街道")).not.toBeInTheDocument();
    expect(screen.queryByText("读书")).not.toBeInTheDocument();
    expect(screen.getAllByRole("time")).toHaveLength(3);
  });

  it("groups by Beijing day and keeps newest entries first", () => {
    render(<Timeline entries={[...entriesForTwoDays].reverse()} />);

    const july26 = screen.getByTestId("day-2026-07-26");
    expect(within(july26).getByText("26")).toBeVisible();
    expect(within(july26).getByText("SUNDAY · JULY · 2 ENTRIES")).toBeVisible();
    expect(within(july26).getAllByRole("article").map((node) => node.dataset.entryId)).toEqual([
      "evening-walk",
      "morning-note",
    ]);
  });

  it("renders an English empty reading state", () => {
    render(<Timeline entries={[]} />);

    expect(screen.getByText("NO PUBLISHED ENTRIES")).toBeVisible();
  });

  it("observes replacement day sections when the day count stays the same", () => {
    const observedDays: string[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe(element: Element) {
          observedDays.push(element.getAttribute("data-day") ?? "");
        }

        disconnect() {
          disconnect();
        }
      },
    );
    const onActiveDayChange = vi.fn();
    const { rerender } = render(
      <Timeline entries={[entriesForTwoDays[0]]} onActiveDayChange={onActiveDayChange} />,
    );

    rerender(
      <Timeline entries={[entriesForTwoDays[2]]} onActiveDayChange={onActiveDayChange} />,
    );

    expect(disconnect).toHaveBeenCalledOnce();
    expect(observedDays).toEqual(["2026-07-26", "2026-07-25"]);
  });
});

describe("DateRail", () => {
  it("links each Beijing day and identifies the active day", () => {
    render(<DateRail entries={entriesForTwoDays} activeDay="2026-07-25" />);

    const activeLink = screen.getByRole("link", { name: "July 25, 2026" });
    expect(activeLink).toHaveAttribute("href", "#day-2026-07-25");
    expect(activeLink).toHaveAttribute("aria-current", "date");
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
});
