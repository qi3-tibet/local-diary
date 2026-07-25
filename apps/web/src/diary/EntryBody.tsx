import type { Entry } from "@diary/contracts";
import ReactMarkdown from "react-markdown";
import { formatEntryTime } from "./date-groups";

type EntryBodyProps = {
  entry: Entry;
  onEdit?(entry: Entry): void;
  onTrash?(entry: Entry): void;
};

export function EntryBody({ entry, onEdit, onTrash }: EntryBodyProps) {
  if (!entry.publishedAt) return null;

  return (
    <article className="entry" data-entry-id={entry.id} tabIndex={0}>
      <time className="entry-time" dateTime={entry.publishedAt}>
        {formatEntryTime(entry.publishedAt)}
      </time>
      <div className="entry-body">
        <ReactMarkdown>{entry.markdown}</ReactMarkdown>
      </div>
      {onEdit || onTrash ? (
        <div className="entry-actions">
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
