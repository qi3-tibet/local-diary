import type { Entry } from "@diary/contracts";
import ReactMarkdown from "react-markdown";
import { formatEntryTime } from "./date-groups";

export function EntryBody({ entry }: { entry: Entry }) {
  if (!entry.publishedAt) return null;

  return (
    <article className="entry" data-entry-id={entry.id}>
      <time className="entry-time" dateTime={entry.publishedAt}>
        {formatEntryTime(entry.publishedAt)}
      </time>
      <div className="entry-body">
        <ReactMarkdown>{entry.markdown}</ReactMarkdown>
      </div>
    </article>
  );
}
