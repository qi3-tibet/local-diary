import { createStore, type StoreApi } from "zustand/vanilla";

export type PlayerTrack = {
  id: string;
  streamUrl: string;
  coverUrl: string | null;
  title: string;
  artist: string | null;
  album: string | null;
};

type AudioEventName =
  | "durationchange"
  | "ended"
  | "error"
  | "timeupdate";

export type AudioOwner = {
  src: string;
  readonly currentSrc?: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  error: { code: number } | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(name: AudioEventName, listener: () => void): void;
  removeEventListener(name: AudioEventName, listener: () => void): void;
};

export type PlayerState = {
  track: PlayerTrack | null;
  visible: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  error: string | null;
  play(track: PlayerTrack): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  seek(seconds: number): void;
  stop(): void;
  setVisibleDay(day: string): void;
  destroy(): void;
};

export type PlayerStore = StoreApi<PlayerState>;

export function createPlayerStore(audio: AudioOwner): PlayerStore {
  const listeners = new Map<AudioEventName, () => void>();
  let activeAttempt = 0;
  const store = createStore<PlayerState>((set, get) => ({
    track: null,
    visible: false,
    playing: false,
    currentTime: 0,
    duration: 0,
    error: null,

    async play(track) {
      const attempt = ++activeAttempt;
      const switching = get().track?.id !== track.id;
      removeListeners();
      if (switching) {
        audio.pause();
        audio.src = track.streamUrl;
        audio.currentTime = 0;
        audio.load();
      }
      set({
        track,
        visible: true,
        playing: switching ? false : get().playing,
        currentTime: switching ? 0 : audio.currentTime,
        duration: finite(audio.duration),
        error: null,
      });
      bindListeners(attempt, track);
      try {
        await audio.play();
        if (isActive(attempt, track)) set({ playing: true, error: null });
      } catch {
        if (isActive(attempt, track)) {
          set({ error: "MEDIA UNAVAILABLE", playing: false, visible: true });
        }
      }
    },

    pause() {
      const attempt = ++activeAttempt;
      const current = get().track;
      removeListeners();
      audio.pause();
      set({ playing: false });
      if (current) bindListeners(attempt, current);
    },

    async resume() {
      const track = get().track;
      if (!track) return;
      const attempt = ++activeAttempt;
      removeListeners();
      bindListeners(attempt, track);
      try {
        await audio.play();
        if (isActive(attempt, track)) set({ playing: true, error: null });
      } catch {
        if (isActive(attempt, track)) {
          set({ error: "MEDIA UNAVAILABLE", playing: false });
        }
      }
    },

    seek(seconds) {
      const duration = finite(audio.duration);
      audio.currentTime = Math.max(0, duration ? Math.min(seconds, duration) : seconds);
      set({ currentTime: audio.currentTime });
    },

    stop() {
      activeAttempt += 1;
      removeListeners();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      set(initialState);
    },

    setVisibleDay() {
      // The player intentionally does not follow or reset with the visible day.
    },

    destroy() {
      get().stop();
    },
  }));

  function bindListeners(attempt: number, track: PlayerTrack): void {
    const listen = (name: AudioEventName, action: () => void) => {
      const listener = () => {
        if (isActive(attempt, track)) action();
      };
      listeners.set(name, listener);
      audio.addEventListener(name, listener);
    };
    listen("timeupdate", () => store.setState({ currentTime: finite(audio.currentTime) }));
    listen("durationchange", () => store.setState({ duration: finite(audio.duration) }));
    listen("ended", () => {
      activeAttempt += 1;
      removeListeners();
      store.setState({ playing: false, currentTime: finite(audio.duration) });
    });
    listen("error", () => {
      activeAttempt += 1;
      removeListeners();
      store.setState({
        error: "MEDIA UNAVAILABLE",
        playing: false,
        visible: true,
      });
    });
  }

  function removeListeners(): void {
    listeners.forEach((listener, name) => audio.removeEventListener(name, listener));
    listeners.clear();
  }

  function isActive(attempt: number, track: PlayerTrack): boolean {
    const activeTrack = store.getState().track;
    return attempt === activeAttempt
      && activeTrack?.id === track.id
      && activeTrack.streamUrl === track.streamUrl
      && sourceMatches(audio.currentSrc || audio.src, track.streamUrl);
  }

  return store;
}

let browserPlayer: PlayerStore | undefined;

export function getBrowserPlayerStore(): PlayerStore {
  if (typeof Audio === "undefined") {
    throw new Error("The diary player requires a browser audio implementation.");
  }
  browserPlayer ??= createPlayerStore(new Audio());
  return browserPlayer;
}

const initialState = {
  track: null,
  visible: false,
  playing: false,
  currentTime: 0,
  duration: 0,
  error: null,
} as const;

function finite(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function sourceMatches(current: string, expected: string): boolean {
  if (!current) return false;
  if (current === expected) return true;
  const base = typeof document === "undefined" ? "http://diary.local/" : document.baseURI;
  try {
    return new URL(current, base).href === new URL(expected, base).href;
  } catch {
    return false;
  }
}
