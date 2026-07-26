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

  it("ignores an older rejection after a newer track starts", async () => {
    const audio = controlledAudio();
    const store = createPlayerStore(audio);
    const second = { ...track, id: "track-2", streamUrl: "/api/v1/music/track-2/stream" };

    const firstPlay = store.getState().play(track);
    const secondPlay = store.getState().play(second);
    audio.resolvePlay(1);
    await secondPlay;
    audio.rejectPlay(0);
    await firstPlay;

    expect(store.getState()).toMatchObject({
      track: second,
      playing: true,
      error: null,
      visible: true,
    });
  });

  it("ignores an older success after the active track fails", async () => {
    const audio = controlledAudio();
    const store = createPlayerStore(audio);
    const second = { ...track, id: "track-2", streamUrl: "/api/v1/music/track-2/stream" };

    const firstPlay = store.getState().play(track);
    const secondPlay = store.getState().play(second);
    audio.rejectPlay(1);
    await secondPlay;
    audio.resolvePlay(0);
    await firstPlay;

    expect(store.getState()).toMatchObject({
      track: second,
      playing: false,
      error: "MEDIA UNAVAILABLE",
      visible: true,
    });
  });

  it("invalidates a pending play when playback is paused or stopped", async () => {
    const pausedAudio = controlledAudio();
    const pausedStore = createPlayerStore(pausedAudio);
    const pendingPause = pausedStore.getState().play(track);
    pausedStore.getState().pause();
    pausedAudio.resolvePlay(0);
    await pendingPause;
    expect(pausedStore.getState()).toMatchObject({ track, playing: false, error: null });

    const stoppedAudio = controlledAudio();
    const stoppedStore = createPlayerStore(stoppedAudio);
    const pendingStop = stoppedStore.getState().play(track);
    stoppedStore.getState().stop();
    stoppedAudio.resolvePlay(0);
    await pendingStop;
    expect(stoppedStore.getState()).toMatchObject({
      track: null,
      playing: false,
      visible: false,
      error: null,
    });
  });

  it("removes stale source listeners and ignores their late media events", async () => {
    const audio = controlledAudio();
    const store = createPlayerStore(audio);
    const second = { ...track, id: "track-2", streamUrl: "/api/v1/music/track-2/stream" };

    const firstPlay = store.getState().play(track);
    const staleError = audio.latestListener("error");
    const staleEnded = audio.latestListener("ended");
    const secondPlay = store.getState().play(second);
    audio.resolvePlay(1);
    await secondPlay;

    staleError();
    staleEnded();
    const activeError = audio.latestListener("error");
    audio.setLoadedSource(track.streamUrl);
    activeError();
    expect(store.getState()).toMatchObject({
      track: second,
      playing: true,
      error: null,
    });
    expect(audio.activeListenerCount()).toBe(4);

    store.getState().stop();
    staleError();
    expect(audio.activeListenerCount()).toBe(0);
    expect(store.getState()).toMatchObject({ track: null, visible: false, error: null });

    audio.rejectPlay(0);
    await firstPlay;
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

function controlledAudio(): AudioOwner & {
  resolvePlay(index: number): void;
  rejectPlay(index: number): void;
  latestListener(name: string): () => void;
  setLoadedSource(source: string): void;
  activeListenerCount(): number;
} {
  const active = new Map<string, Set<() => void>>();
  const history = new Map<string, Array<() => void>>();
  const plays: Array<ReturnType<typeof deferred>> = [];
  let loadedSource = "";
  return {
    src: "",
    get currentSrc() {
      return loadedSource;
    },
    currentTime: 0,
    duration: 30,
    paused: true,
    error: null,
    play() {
      const operation = deferred();
      plays.push(operation);
      return operation.promise;
    },
    pause() {
      this.paused = true;
    },
    removeAttribute(name) {
      if (name === "src") {
        this.src = "";
        loadedSource = "";
      }
    },
    load() {
      loadedSource = this.src;
    },
    addEventListener(name, listener) {
      const bucket = active.get(name) ?? new Set();
      bucket.add(listener);
      active.set(name, bucket);
      const recorded = history.get(name) ?? [];
      recorded.push(listener);
      history.set(name, recorded);
    },
    removeEventListener(name, listener) {
      active.get(name)?.delete(listener);
    },
    resolvePlay(index) {
      plays[index]?.resolve();
    },
    rejectPlay(index) {
      plays[index]?.reject(new Error("play failed"));
    },
    latestListener(name) {
      const listeners = history.get(name) ?? [];
      const listener = listeners.at(-1);
      if (!listener) throw new Error(`Missing ${name} listener`);
      return listener;
    },
    setLoadedSource(source) {
      loadedSource = source;
    },
    activeListenerCount() {
      return [...active.values()].reduce((count, listeners) => count + listeners.size, 0);
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
