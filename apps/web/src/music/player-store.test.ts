import { describe, expect, it, vi } from "vitest";
import {
  createPlayerStore,
  getBrowserPlayerStore,
  type AudioOwner,
  type PlayerTrack,
} from "./player-store";

const track: PlayerTrack = {
  id: "track-1",
  streamUrl: "/api/v1/music/track-1/stream",
  coverUrl: null,
  title: "Pink + White",
  artist: "Frank Ocean",
  album: "Blonde",
};

describe("player store", () => {
  it("keeps the active track when the visible day changes", async () => {
    const audio = fakeAudio();
    const store = createPlayerStore(audio);

    await store.getState().play(track);
    store.getState().setVisibleDay("2026-07-25");

    expect(store.getState().track?.id).toBe(track.id);
    expect(store.getState().visible).toBe(true);
    expect(audio.src).toBe(track.streamUrl);
  });

  it("owns one audio object while tracks change and cleans it on destroy", async () => {
    const audio = fakeAudio();
    const store = createPlayerStore(audio);
    const second = { ...track, id: "track-2", streamUrl: "/api/v1/music/track-2/stream" };

    await store.getState().play(track);
    await store.getState().play(second);
    store.getState().seek(12);
    store.getState().destroy();

    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.currentTime).toBe(12);
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(store.getState().track).toBeNull();
  });

  it("mirrors progress, duration, pause, and playback errors", async () => {
    const audio = fakeAudio();
    const store = createPlayerStore(audio);
    await store.getState().play(track);

    audio.currentTime = 8;
    audio.duration = 30;
    audio.emit("durationchange");
    audio.emit("timeupdate");
    expect(store.getState()).toMatchObject({ currentTime: 8, duration: 30 });

    store.getState().pause();
    expect(store.getState().playing).toBe(false);

    audio.error = { code: 4 };
    audio.emit("error");
    expect(store.getState()).toMatchObject({
      error: "MEDIA UNAVAILABLE",
      playing: false,
      visible: true,
    });
  });

  it("creates only one browser audio owner across strict render initializers", () => {
    const AudioConstructor = vi.fn(() => fakeAudio());
    vi.stubGlobal("Audio", AudioConstructor);

    expect(getBrowserPlayerStore()).toBe(getBrowserPlayerStore());
    expect(AudioConstructor).toHaveBeenCalledOnce();
  });
});

function fakeAudio(): AudioOwner & {
  emit(name: string): void;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    src: "",
    currentTime: 0,
    duration: Number.NaN,
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
    removeAttribute: vi.fn(function (this: AudioOwner, name: string) {
      if (name === "src") this.src = "";
    }),
    load: vi.fn(),
    addEventListener(name, listener) {
      const bucket = listeners.get(name) ?? new Set();
      bucket.add(listener);
      listeners.set(name, bucket);
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    emit(name) {
      listeners.get(name)?.forEach((listener) => listener());
    },
  };
}
