import type { DraftInput, Entry } from "@diary/contracts";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../api/client";
import { DiaryMarkdown } from "../diary/EntryBody";
import { ImageInsert } from "./ImageInsert";
import { insertAtSelection } from "./insert-at-selection";
import { ModeGlyph } from "./ModeGlyph";
import { useSilentDraft } from "./useSilentDraft";

const emptyDraft: DraftInput = {
  title: "",
  markdown: "",
  tags: [],
};

type EditorProps = {
  entry?: Entry;
  onCancel(): void;
  onComplete(entry: Entry): void;
};

type EditorFormProps = EditorProps & {
  initialValue: DraftInput;
  draftId?: string;
};

function EditorForm({ entry, initialValue, draftId, onCancel, onComplete }: EditorFormProps) {
  const [value, setValue] = useState(initialValue);
  const [preview, setPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const uploadEntryId = useRef(entry?.id ?? draftId);
  const isDraft = !entry;

  const draftPersistence = useSilentDraft(value, api.saveDraft, isDraft && !submitting);

  async function insertImage(image: File): Promise<void> {
    const field = textarea.current;
    if (!field) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const entryId = uploadEntryId.current
      ?? (await api.saveDraft(value)).id;
    uploadEntryId.current = entryId;
    const uploaded = await api.uploadImage(entryId, image);
    const markdown = `![${uploaded.alt}](${uploaded.markdownUrl})`;
    const cursor = start + markdown.length;
    setValue((current) => ({
      ...current,
      markdown: insertAtSelection(current.markdown, start, end, markdown).value,
    }));
    window.requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(cursor, cursor);
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!value.title.trim() || !value.markdown.trim()) {
      setError("TITLE AND MARKDOWN BODY ARE REQUIRED");
      return;
    }

    setSubmitting(true);
    setError(undefined);
    try {
      const completed = entry
        ? await api.updateEntry(entry.id, value)
        : await draftPersistence.finalize(value).then(() => api.publishDraft());
      onComplete(completed);
    } catch {
      if (isDraft) draftPersistence.resume();
      setError(entry ? "THE ENTRY COULD NOT BE SAVED" : "THE DRAFT COULD NOT BE PUBLISHED");
      setSubmitting(false);
    }
  }

  return (
    <main className="editor-page">
      <form className="editor-form" aria-label="Diary editor" onSubmit={(event) => void submit(event)}>
        <div className="editor-heading">
          <label className="editor-title-field">
            <span>TITLE</span>
            <input
              aria-label="Title"
              autoFocus
              value={value.title}
              onChange={(event) => setValue({ ...value, title: event.target.value })}
            />
          </label>
          <div className="editor-glyphs">
            {!preview ? <ImageInsert onSelect={insertImage} /> : null}
            <ModeGlyph preview={preview} onToggle={() => setPreview((current) => !current)} />
          </div>
        </div>

        {preview ? (
          <div className="editor-preview entry-body" aria-label="Markdown preview">
            <DiaryMarkdown>{value.markdown}</DiaryMarkdown>
          </div>
        ) : (
          <label className="editor-body-field">
            <span>MARKDOWN</span>
            <textarea
              ref={textarea}
              aria-label="Markdown body"
              value={value.markdown}
              onChange={(event) => setValue({ ...value, markdown: event.target.value })}
            />
          </label>
        )}

        {error ? <p className="editor-error" role="alert">{error}</p> : null}
        <div className="editor-actions">
          <button type="button" onClick={onCancel}>CANCEL</button>
          <button type="submit" disabled={submitting}>
            {entry ? "SAVE" : "DONE"}
          </button>
        </div>
      </form>
    </main>
  );
}

export function Editor(props: EditorProps) {
  const draftQuery = useQuery({
    queryKey: ["draft"],
    queryFn: api.getDraft,
    enabled: !props.entry,
  });

  if (props.entry) {
    return (
      <EditorForm
        {...props}
        initialValue={{
          title: props.entry.title,
          markdown: props.entry.markdown,
          tags: props.entry.tags,
        }}
      />
    );
  }

  if (draftQuery.isPending) {
    return <p className="reading-status" role="status">OPENING DRAFT</p>;
  }
  if (draftQuery.isError) {
    return (
      <div className="reading-status" role="alert">
        <p>THE DRAFT COULD NOT BE OPENED</p>
        <button type="button" onClick={() => void draftQuery.refetch()}>TRY AGAIN</button>
      </div>
    );
  }

  const draft = draftQuery.data;
  return (
    <EditorForm
      {...props}
      key={draft?.id ?? "new-draft"}
      initialValue={draft ?? emptyDraft}
      draftId={draft?.id}
    />
  );
}
