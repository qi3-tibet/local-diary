import type { EntryMusic } from "@diary/contracts";
import type { PlayerStore, PlayerTrack } from "./player-store";

type MusicCardProps = {
  music: EntryMusic;
  player?: PlayerStore;
  onPlay?(): void;
};

export function MusicCard({ music, player, onPlay }: MusicCardProps) {
  const title = music.title ?? music.originalFilename;
  const details = [music.artist, music.album].filter(Boolean).join(" · ");
  const track: PlayerTrack = {
    id: music.mediaId,
    streamUrl: music.streamUrl,
    coverUrl: music.coverUrl,
    title,
    artist: music.artist,
    album: music.album,
  };

  return (
    <section className="music-card" aria-label={`Music ${title}`}>
      <div className="music-cover">
        <span aria-hidden="true" />
        {music.coverUrl ? (
          <img
            src={music.coverUrl}
            alt=""
            loading="lazy"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        ) : null}
      </div>
      <div className="music-card-copy music-metadata">
        <strong>{title}</strong>
        {details ? <span>{details}</span> : <span>UNKNOWN ARTIST</span>}
      </div>
      {music.available ? (
        <button
          className="music-play"
          type="button"
          aria-label={`Play ${title}`}
          onClick={() => {
            onPlay?.();
            if (player) void player.getState().play(track);
          }}
        >
          <span aria-hidden="true" />
        </button>
      ) : (
        <span className="music-unavailable">MEDIA UNAVAILABLE</span>
      )}
    </section>
  );
}
