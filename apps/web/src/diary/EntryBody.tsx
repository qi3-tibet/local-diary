import type { Entry } from "@diary/contracts";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { api } from "../api/client";
import { MusicCard } from "../music/MusicCard";
import type { PlayerStore } from "../music/player-store";
import { formatEntryTime } from "./date-groups";

type EntryBodyProps = {
  entry: Entry;
  onEdit?(entry: Entry): void;
  onTrash?(entry: Entry): void;
  player?: PlayerStore;
};

export function DiaryMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      urlTransform={(url) => url.startsWith("media:") ? url : defaultUrlTransform(url)}
      components={{
        img: ({ src = "", alt = "" }) => {
          const mediaId = src.startsWith("media:") ? src.slice(6) : "";
          return (
            <img
              src={mediaId ? api.mediaDisplayUrl(mediaId) : src}
              alt={alt}
              loading="lazy"
              decoding="async"
            />
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

export function EntryBody({ entry, onEdit, onTrash, player }: EntryBodyProps) {
  if (!entry.publishedAt) return null;

  return (
    <article className="entry" data-entry-id={entry.id} tabIndex={0}>
      <time className="entry-time" dateTime={entry.publishedAt}>
        {formatEntryTime(entry.publishedAt)}
      </time>
      <div className="entry-body">
        <DiaryMarkdown>{entry.markdown}</DiaryMarkdown>
        {entry.music ? <MusicCard music={entry.music} player={player} /> : null}
      </div>
      {onEdit || onTrash ? (
        <div className="entry-actions management-action">
          {onEdit ? (
            <button type="button" aria-label="Edit entry" onClick={() => onEdit(entry)}>
              EDIT
            </button>
          ) : null}
          {onTrash ? (
            <button type="button" aria-label="Move to trash" onClick={() => onTrash(entry)}>
              MOVE TO TRASH
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
