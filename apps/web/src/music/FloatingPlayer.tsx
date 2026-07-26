import { useStore } from "zustand";
import type { PlayerStore } from "./player-store";

export function FloatingPlayer({ player }: { player: PlayerStore }) {
  const state = useStore(player);
  if (!state.visible || !state.track) return null;

  const { track } = state;
  return (
    <section className="floating-player" role="region" aria-label="Now playing">
      <div className="floating-cover">
        <span aria-hidden="true" />
        {track.coverUrl ? (
          <img
            src={track.coverUrl}
            alt=""
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        ) : null}
      </div>
      <div className="floating-copy">
        <strong>{track.title}</strong>
        {track.artist ? <span>{track.artist}</span> : null}
        {state.error ? <span className="player-error">{state.error}</span> : null}
      </div>
      <button
        className={state.playing ? "player-pause" : "player-play"}
        type="button"
        aria-label={state.playing ? `Pause ${track.title}` : `Play ${track.title}`}
        onClick={() => void (state.playing ? state.pause() : state.resume())}
      >
        <span aria-hidden="true" />
      </button>
      <label className="player-progress">
        <span className="visually-hidden">Playback position</span>
        <input
          aria-label="Playback position"
          type="range"
          min={0}
          max={state.duration || 0}
          step={0.1}
          value={Math.min(state.currentTime, state.duration || 0)}
          onChange={(event) => state.seek(Number(event.target.value))}
        />
      </label>
      <span className="player-time">
        {formatTime(state.currentTime)} / {formatTime(state.duration)}
      </span>
      <button className="player-stop" type="button" aria-label="Stop playback" onClick={state.stop}>
        <span aria-hidden="true" />
      </button>
    </section>
  );
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}
