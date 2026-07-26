// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Entry } from "@diary/contracts";
import { WindowedTimeline } from "./WindowedTimeline";

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

describe("WindowedTimeline", () => {
  afterEach(cleanup);
  it("mounts only the active day plus seven day groups on either side", () => {
    render(<WindowedTimeline entries={Array.from({ length: 30 }, (_, day) => entry(day))} activeDay="2020-07-16" />);
    expect(screen.getByTestId("day-2020-07-16")).toBeInTheDocument();
    expect(document.querySelectorAll("article.entry")).toHaveLength(15);
    expect(document.querySelector("#day-2020-07-01")).not.toBeInTheDocument();
  });

  it("moves its visible window and retains nonzero estimated spacers for omitted days", () => {
    const entries = Array.from({ length: 40 }, (_, day) => entry(day));
    const { rerender } = render(<WindowedTimeline entries={entries} activeDay="2020-07-08" />);
    expect(screen.getByTestId("day-2020-07-01")).toBeInTheDocument();
    rerender(<WindowedTimeline entries={entries} activeDay="2020-07-28" />);
    expect(screen.getByTestId("day-2020-07-28")).toBeInTheDocument();
    expect(screen.queryByTestId("day-2020-07-01")).not.toBeInTheDocument();
    const spacers = [...document.querySelectorAll<HTMLElement>(".reading-page > div[aria-hidden='true']")];
    expect(spacers.some((spacer) => Number.parseFloat(spacer.style.height) > 0)).toBe(true);
  });
});
