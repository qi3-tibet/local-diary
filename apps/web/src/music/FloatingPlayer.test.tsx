// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FloatingPlayer } from "./FloatingPlayer";
import { createPlayerStore, type AudioOwner } from "./player-store";

afterEach(cleanup);

it("appears only for an active track and exposes geometric playback controls", async () => {
  const audio = fakeAudio();
  const player = createPlayerStore(audio);
  const { container } = render(<FloatingPlayer player={player} />);
  expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();

  await player.getState().play({
    id: "track-1",
    streamUrl: "/track.mp3",
    coverUrl: null,
    title: "Pink + White",
    artist: "Frank Ocean",
    album: "Blonde",
  });

  expect(screen.getByRole("region", { name: "Now playing" })).toHaveTextContent("Pink + White");
  expect(screen.getByRole("slider", { name: "Playback position" })).toBeVisible();
  expect(container.querySelector("svg")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Pause Pink + White" }));
  expect(audio.pause).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stop playback" }));
  expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
});

function fakeAudio(): AudioOwner & {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    src: "",
    currentTime: 0,
    duration: 30,
    paused: true,
    error: null,
    play: vi.fn(async function (this: AudioOwner) {
      this.paused = false;
      listeners.get("play")?.forEach((listener) => listener());
    }),
    pause: vi.fn(function (this: AudioOwner) {
      this.paused = true;
      listeners.get("pause")?.forEach((listener) => listener());
    }),
    removeAttribute(name) {
      if (name === "src") this.src = "";
    },
    load() {},
    addEventListener(name, listener) {
      const bucket = listeners.get(name) ?? new Set();
      bucket.add(listener);
      listeners.set(name, bucket);
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener);
    },
  };
}
