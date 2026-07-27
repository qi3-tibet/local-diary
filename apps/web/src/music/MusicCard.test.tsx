// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MusicCard } from "./MusicCard";

afterEach(cleanup);

it("shows effective metadata and starts the global player", () => {
  const onPlay = vi.fn();
  render(
    <MusicCard
      music={{
        mediaId: "00000000-0000-4000-8000-000000000001",
        title: "雨夜",
        artist: "某人",
        album: "窗边",
        year: 2026,
        coverMediaId: null,
        coverMime: null,
        recognitionStatus: "manual",
        originalFilename: "rain.mp3",
        streamUrl: "/api/v1/music/00000000-0000-4000-8000-000000000001/stream",
        coverUrl: null,
        available: true,
      }}
      onPlay={onPlay}
    />,
  );

  expect(screen.getByText("雨夜")).toBeVisible();
  expect(screen.getByText("某人 · 窗边")).toBeVisible();
  expect(document.querySelector("svg")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Play 雨夜" }));
  expect(onPlay).toHaveBeenCalledTimes(1);
});

it("keeps unavailable music readable without an interactive play control", () => {
  render(
    <MusicCard
      music={{
        mediaId: "00000000-0000-4000-8000-000000000001",
        title: null,
        artist: null,
        album: null,
        year: null,
        coverMediaId: null,
        coverMime: null,
        recognitionStatus: "manual_required",
        originalFilename: "rain.mp3",
        streamUrl: "/api/v1/music/00000000-0000-4000-8000-000000000001/stream",
        coverUrl: null,
        available: false,
      }}
      onPlay={vi.fn()}
    />,
  );

  expect(screen.getByText("rain.mp3")).toBeVisible();
  expect(screen.getByText("MEDIA UNAVAILABLE")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Play/ })).toBeNull();
});

it("reveals a plain solid fallback without a note glyph when stored cover art cannot load", () => {
  const { container } = render(
    <MusicCard
      music={{
        mediaId: "00000000-0000-4000-8000-000000000001",
        title: "Song",
        artist: "Artist",
        album: null,
        year: null,
        coverMediaId: "00000000-0000-4000-8000-000000000002",
        coverMime: "image/png",
        recognitionStatus: "embedded",
        originalFilename: "song.mp3",
        streamUrl: "/stream",
        coverUrl: "/missing-cover",
        available: true,
      }}
      onPlay={vi.fn()}
    />,
  );
  const cover = container.querySelector(".music-cover")!;
  const image = cover.querySelector("img")!;
  expect(cover.querySelector("span")).toBeNull();

  fireEvent.error(image);
  expect(image).toHaveAttribute("hidden");
});
