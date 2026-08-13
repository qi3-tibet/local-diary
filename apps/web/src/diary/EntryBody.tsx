import type { Entry } from "@diary/contracts";
import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { api } from "../api/client";
import { CodeBlock } from "./CodeBlock";
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
      remarkPlugins={[remarkHardLineBreaks]}
      urlTransform={(url) => url.startsWith("media:") ? url : defaultUrlTransform(url)}
      components={{
        code: InlineCode,
        pre: MarkdownPre,
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

function InlineCode({ children, className }: { children?: ReactNode; className?: string }) {
  return <code className={className}>{children}</code>;
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children).find(isValidElement);
  if (!child) return <pre>{children}</pre>;
  const props = child.props as { children?: ReactNode; className?: string };
  return <CodeBlock className={props.className}>{props.children}</CodeBlock>;
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  [key: string]: unknown;
};

function remarkHardLineBreaks() {
  return (tree: unknown) => {
    replaceSoftLineBreaks(tree as MarkdownNode);
  };
}

function replaceSoftLineBreaks(node: MarkdownNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type !== "text" || !child.value?.includes("\n")) {
      replaceSoftLineBreaks(child);
      return [child];
    }
    const lines = child.value.split("\n");
    return lines.flatMap((value, index) => [
      { ...child, value },
      ...(index < lines.length - 1 ? [{ type: "break" }] : []),
    ]);
  });
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
