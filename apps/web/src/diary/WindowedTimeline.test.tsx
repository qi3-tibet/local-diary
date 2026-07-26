// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
  it("mounts only the active day plus seven day groups on either side", () => {
    render(<WindowedTimeline entries={Array.from({ length: 30 }, (_, day) => entry(day))} activeDay="2020-07-16" />);
    expect(screen.getByTestId("day-2020-07-16")).toBeInTheDocument();
    expect(document.querySelectorAll("article.entry")).toHaveLength(15);
    expect(document.querySelector("#day-2020-07-01")).not.toBeInTheDocument();
  });
});
