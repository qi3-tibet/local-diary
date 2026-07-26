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
  | "pause"
  | "play"
  | "timeupdate";

export type AudioOwner = {
  src: string;
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
  const store = createStore<PlayerState>((set, get) => ({
    track: null,
    visible: false,
    playing: false,
    currentTime: 0,
    duration: 0,
    error: null,

    async play(track) {
      const switching = get().track?.id !== track.id;
      if (switching) {
        audio.pause();
        audio.src = track.streamUrl;
        audio.currentTime = 0;
      }
      set({
        track,
        visible: true,
        currentTime: switching ? 0 : audio.currentTime,
        duration: finite(audio.duration),
        error: null,
      });
      try {
        await audio.play();
      } catch {
        set({ error: "MEDIA UNAVAILABLE", playing: false, visible: true });
      }
    },

    pause() {
      audio.pause();
      set({ playing: false });
    },

    async resume() {
      if (!get().track) return;
      try {
        await audio.play();
      } catch {
        set({ error: "MEDIA UNAVAILABLE", playing: false });
      }
    },

    seek(seconds) {
      const duration = finite(audio.duration);
      audio.currentTime = Math.max(0, duration ? Math.min(seconds, duration) : seconds);
      set({ currentTime: audio.currentTime });
    },

    stop() {
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
      listeners.forEach((listener, name) => audio.removeEventListener(name, listener));
      listeners.clear();
    },
  }));

  const listen = (name: AudioEventName, listener: () => void) => {
    listeners.set(name, listener);
    audio.addEventListener(name, listener);
  };
  listen("play", () => store.setState({ playing: true, error: null }));
  listen("pause", () => store.setState({ playing: false }));
  listen("timeupdate", () => store.setState({ currentTime: finite(audio.currentTime) }));
  listen("durationchange", () => store.setState({ duration: finite(audio.duration) }));
  listen("ended", () => store.setState({ playing: false, currentTime: finite(audio.duration) }));
  listen("error", () => store.setState({
    error: "MEDIA UNAVAILABLE",
    playing: false,
    visible: true,
  }));

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
