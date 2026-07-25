import type { DraftInput, Entry } from "@diary/contracts";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import ReactMarkdown from "react-markdown";
import { api } from "../api/client";
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
};

function EditorForm({ entry, initialValue, onCancel, onComplete }: EditorFormProps) {
  const [value, setValue] = useState(initialValue);
  const [preview, setPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const isDraft = !entry;

  useSilentDraft(value, api.saveDraft, isDraft && !submitting);

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
        : await api.saveDraft(value).then(() => api.publishDraft());
      onComplete(completed);
    } catch {
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
          <ModeGlyph preview={preview} onToggle={() => setPreview((current) => !current)} />
        </div>

        {preview ? (
          <div className="editor-preview entry-body" aria-label="Markdown preview">
            <ReactMarkdown>{value.markdown}</ReactMarkdown>
          </div>
        ) : (
          <label className="editor-body-field">
            <span>MARKDOWN</span>
            <textarea
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
    />
  );
}
