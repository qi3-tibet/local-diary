import type {
  MusicMetadataOverride,
  RecognitionCandidate,
} from "@diary/contracts";
import { useEffect, useRef, useState } from "react";

type EditableMusicMetadata = MusicMetadataOverride & {
  recognitionStatus: "embedded" | "manual_required" | "candidates" | "recognized" | "manual";
};

type MusicMetadataEditorProps = {
  metadata: EditableMusicMetadata;
  candidates: RecognitionCandidate[];
  busy?: boolean;
  onSave(overrides: MusicMetadataOverride): void | Promise<void>;
  onSelectCandidate(candidateId: string): void | Promise<void>;
  onCoverSelect(file: File): void | Promise<void>;
  onRecognize?(): void | Promise<void>;
};

export function MusicMetadataEditor({
  metadata,
  candidates,
  busy = false,
  onSave,
  onSelectCandidate,
  onCoverSelect,
  onRecognize,
}: MusicMetadataEditorProps) {
  const [title, setTitle] = useState(metadata.title ?? "");
  const [artist, setArtist] = useState(metadata.artist ?? "");
  const [album, setAlbum] = useState(metadata.album ?? "");
  const [year, setYear] = useState(metadata.year?.toString() ?? "");
  const coverInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(metadata.title ?? "");
    setArtist(metadata.artist ?? "");
    setAlbum(metadata.album ?? "");
    setYear(metadata.year?.toString() ?? "");
  }, [metadata.album, metadata.artist, metadata.title, metadata.year]);

  function submit(): void {
    void onSave({
      title: nullable(title),
      artist: nullable(artist),
      album: nullable(album),
      year: year ? Number(year) : null,
    });
  }

  return (
    <section className="music-metadata-editor" aria-label="Music metadata" aria-busy={busy}>
      <header className="music-metadata-heading">
        <span>MUSIC METADATA</span>
        {metadata.recognitionStatus === "manual_required"
          ? <span className="music-metadata-status">MANUAL DETAILS REQUIRED</span>
          : null}
      </header>

      {candidates.length > 0 ? (
        <div className="music-candidates" aria-label="Recognition candidates">
          {candidates.map((candidate) => (
            <div className="music-candidate" key={candidate.id}>
              <span className="music-candidate-copy">
                <strong>{candidate.title ?? "UNTITLED"}</strong>
                <span>{candidate.artist ?? "UNKNOWN ARTIST"}</span>
                {candidate.album ? <span>{candidate.album}</span> : null}
              </span>
              <button
                type="button"
                disabled={busy}
                aria-label={`Use ${candidate.title ?? "untitled"} by ${candidate.artist ?? "unknown artist"}`}
                onClick={() => void onSelectCandidate(candidate.id)}
              >
                USE
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="music-metadata-form">
        <label>
          <span>SONG TITLE</span>
          <input
            aria-label="Song title"
            disabled={busy}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          <span>ARTIST</span>
          <input
            aria-label="Artist"
            disabled={busy}
            value={artist}
            onChange={(event) => setArtist(event.target.value)}
          />
        </label>
        <label>
          <span>ALBUM</span>
          <input
            aria-label="Album"
            disabled={busy}
            value={album}
            onChange={(event) => setAlbum(event.target.value)}
          />
        </label>
        <label>
          <span>YEAR</span>
          <input
            aria-label="Year"
            disabled={busy}
            inputMode="numeric"
            min={1000}
            max={9999}
            type="number"
            value={year}
            onChange={(event) => setYear(event.target.value)}
          />
        </label>

        <div className="music-metadata-actions">
          <input
            ref={coverInput}
            hidden
            accept="image/jpeg,image/png,image/webp,image/avif"
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onCoverSelect(file);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={busy}
            aria-label="Replace cover"
            onClick={() => coverInput.current?.click()}
          >
            REPLACE COVER
          </button>
          {onRecognize ? (
            <button
              type="button"
              disabled={busy}
              aria-label="Recognize music"
              onClick={() => void onRecognize()}
            >
              RECOGNIZE
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            aria-label="Save music metadata"
            onClick={submit}
          >
            SAVE
          </button>
        </div>
      </div>
    </section>
  );
}

function nullable(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}
