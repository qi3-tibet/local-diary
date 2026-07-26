import type {
  DraftInput,
  Entry,
  EntryMusic,
  MusicMetadataOverride,
  RecognitionCandidate,
} from "@diary/contracts";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { api, type EditableMusic } from "../api/client";
import { DiaryMarkdown } from "../diary/EntryBody";
import { ImageInsert } from "./ImageInsert";
import { insertAtSelection } from "./insert-at-selection";
import { ModeGlyph } from "./ModeGlyph";
import { MusicAttach } from "./MusicAttach";
import { MusicMetadataEditor } from "./MusicMetadataEditor";
import {
  transformSelectionAfterReplacement,
  transformUploadAnchor,
  transformUploadAnchorAfterReplacement,
  type TextRange,
} from "./selection-anchor";
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
  initialMusic?: EntryMusic | null;
};

function EditorForm({
  entry,
  initialValue,
  draftId,
  initialMusic,
  onCancel,
  onComplete,
}: EditorFormProps) {
  const [value, setValue] = useState(initialValue);
  const [preview, setPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [musicBusy, setMusicBusy] = useState(false);
  const [music, setMusic] = useState<EditableMusic | EntryMusic | null>(initialMusic ?? null);
  const [musicCandidates, setMusicCandidates] = useState<RecognitionCandidate[]>([]);
  const [musicError, setMusicError] = useState<string>();
  const [error, setError] = useState<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const uploadEntryId = useRef(entry?.id ?? draftId);
  const latestValue = useRef(initialValue);
  const interactionRevision = useRef(0);
  const uploadAnchor = useRef<{
    range: TextRange;
    revision: number;
    affinity: "left" | "right";
  } | null>(null);
  const pendingInputRange = useRef<TextRange | null>(null);
  const pendingUpload = useRef<Promise<void> | null>(null);
  const pendingMusic = useRef<Promise<void> | null>(null);
  const isDraft = !entry;

  const draftPersistence = useSilentDraft(value, api.saveDraft, isDraft && !submitting);

  async function insertImage(image: File): Promise<void> {
    const field = textarea.current;
    if (!field) return;
    uploadAnchor.current = {
      range: { start: field.selectionStart, end: field.selectionEnd },
      revision: interactionRevision.current,
      affinity: "left",
    };
    const entryId = uploadEntryId.current
      ?? (await api.saveDraft(latestValue.current)).id;
    uploadEntryId.current = entryId;
    try {
      const uploaded = await api.uploadImage(entryId, image);
      const tracked = uploadAnchor.current;
      if (!tracked) return;
      const markdown = `![${uploaded.alt}](${uploaded.markdownUrl})`;
      const fieldAtCompletion = textarea.current;
      const userInteracted = interactionRevision.current !== tracked.revision;
      const wasFocused = document.activeElement === fieldAtCompletion;
      const userSelection = fieldAtCompletion
        ? { start: fieldAtCompletion.selectionStart, end: fieldAtCompletion.selectionEnd }
        : null;
      const insertion = insertAtSelection(
        latestValue.current.markdown,
        tracked.range.start,
        tracked.range.end,
        markdown,
      );
      const nextValue = { ...latestValue.current, markdown: insertion.value };
      latestValue.current = nextValue;
      setValue(nextValue);
      uploadAnchor.current = null;

      window.requestAnimationFrame(() => {
        const currentField = textarea.current;
        if (!currentField) return;
        if (!userInteracted) {
          currentField.focus();
          currentField.setSelectionRange(insertion.cursor, insertion.cursor);
        } else if (wasFocused && userSelection) {
          const selection = transformSelectionAfterReplacement(
            userSelection,
            tracked.range,
            markdown.length,
          );
          currentField.setSelectionRange(selection.start, selection.end);
        }
      });
    } finally {
      uploadAnchor.current = null;
    }
  }

  function selectImage(image: File): Promise<void> {
    let operation!: Promise<void>;
    operation = (async () => {
      setUploading(true);
      try {
        await insertImage(image);
      } finally {
        if (pendingUpload.current === operation) {
          pendingUpload.current = null;
          setUploading(false);
        }
      }
    })();
    pendingUpload.current = operation;
    return operation;
  }

  function coordinateMusic(work: () => Promise<void>): Promise<void> {
    let operation!: Promise<void>;
    operation = (async () => {
      setMusicBusy(true);
      setMusicError(undefined);
      try {
        await work();
      } finally {
        if (pendingMusic.current === operation) {
          pendingMusic.current = null;
          setMusicBusy(false);
        }
      }
    })();
    pendingMusic.current = operation;
    return operation;
  }

  function selectMusic(file: File): Promise<void> {
    return coordinateMusic(async () => {
      const entryId = uploadEntryId.current
        ?? (await api.saveDraft(latestValue.current)).id;
      uploadEntryId.current = entryId;
      const attached = await api.uploadMusic(entryId, file);
      const withFilename = {
        ...attached,
        originalFilename: attached.originalFilename ?? file.name,
      };
      setMusic(withFilename);
      try {
        const recognized = await api.recognizeMusic(entryId);
        setMusic({ ...withFilename, ...recognized });
        setMusicCandidates(recognized.candidates ?? []);
      } catch {
        setMusicError("MUSIC RECOGNITION IS UNAVAILABLE");
      }
    }).catch(() => {
      setMusicError("THE MP3 COULD NOT BE ATTACHED");
    });
  }

  function saveMusicMetadata(overrides: MusicMetadataOverride): Promise<void> {
    return coordinateMusic(async () => {
      const entryId = uploadEntryId.current;
      if (!entryId) return;
      const updated = await api.patchMusicMetadata(entryId, overrides);
      setMusic((current) => current ? { ...current, ...updated } : updated);
      setMusicCandidates(updated.candidates ?? []);
    }).catch(() => {
      setMusicError("MUSIC METADATA COULD NOT BE SAVED");
    });
  }

  function selectMusicCandidate(candidateId: string): Promise<void> {
    return coordinateMusic(async () => {
      const entryId = uploadEntryId.current;
      if (!entryId) return;
      const updated = await api.selectMusicCandidate(entryId, candidateId);
      setMusic((current) => current ? { ...current, ...updated } : updated);
      setMusicCandidates([]);
    }).catch(() => {
      setMusicError("THE MUSIC MATCH COULD NOT BE USED");
    });
  }

  function replaceMusicCover(file: File): Promise<void> {
    return coordinateMusic(async () => {
      const entryId = uploadEntryId.current;
      if (!entryId) return;
      const cover = await api.uploadImage(entryId, file);
      const updated = await api.patchMusicMetadata(entryId, { coverMediaId: cover.mediaId });
      setMusic((current) => current ? { ...current, ...updated } : updated);
      setMusicCandidates(updated.candidates ?? []);
    }).catch(() => {
      setMusicError("THE COVER COULD NOT BE REPLACED");
    });
  }

  function recognizeAgain(): Promise<void> {
    return coordinateMusic(async () => {
      const entryId = uploadEntryId.current;
      if (!entryId) return;
      const recognized = await api.recognizeMusic(entryId);
      setMusic((current) => current ? { ...current, ...recognized } : recognized);
      setMusicCandidates(recognized.candidates ?? []);
    }).catch(() => {
      setMusicError("MUSIC RECOGNITION IS UNAVAILABLE");
    });
  }

  function changeTitle(title: string): void {
    const nextValue = { ...latestValue.current, title };
    latestValue.current = nextValue;
    setValue(nextValue);
  }

  function changeMarkdown(markdown: string): void {
    const current = latestValue.current;
    if (uploadAnchor.current) {
      const inputRange = pendingInputRange.current;
      const replacementLength = inputRange
        ? markdown.length - (current.markdown.length - (inputRange.end - inputRange.start))
        : -1;
      const currentAnchor = uploadAnchor.current;
      const overlapsAnchor = inputRange
        ? inputRange.start === inputRange.end
          ? currentAnchor.range.start < inputRange.start
            && inputRange.start < currentAnchor.range.end
          : inputRange.start < currentAnchor.range.end
            && inputRange.end > currentAnchor.range.start
        : false;
      uploadAnchor.current = {
        ...currentAnchor,
        affinity: overlapsAnchor ? "right" : currentAnchor.affinity,
        range: inputRange && replacementLength >= 0
          ? transformUploadAnchorAfterReplacement(
              currentAnchor.range,
              inputRange,
              replacementLength,
              currentAnchor.affinity,
            )
          : transformUploadAnchor(currentAnchor.range, current.markdown, markdown),
      };
    }
    pendingInputRange.current = null;
    interactionRevision.current += 1;
    const nextValue = { ...current, markdown };
    latestValue.current = nextValue;
    setValue(nextValue);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!latestValue.current.title.trim() || !latestValue.current.markdown.trim()) {
      setError("TITLE AND MARKDOWN BODY ARE REQUIRED");
      return;
    }

    setSubmitting(true);
    setError(undefined);
    try {
      await Promise.all([pendingUpload.current, pendingMusic.current]);
      const finalValue = latestValue.current;
      const completed = entry
        ? await api.updateEntry(entry.id, finalValue)
        : await draftPersistence.finalize(finalValue).then(() => api.publishDraft());
      onComplete(completed);
    } catch {
      if (isDraft) draftPersistence.resume();
      setError(entry ? "THE ENTRY COULD NOT BE SAVED" : "THE DRAFT COULD NOT BE PUBLISHED");
      setSubmitting(false);
    }
  }

  const busy = uploading || musicBusy || submitting;

  function cancel(): void {
    if (busy) return;
    onCancel();
  }

  return (
    <main className="editor-page">
      <form
        className="editor-form"
        aria-label="Diary editor"
        aria-busy={busy}
        onSubmit={(event) => void submit(event)}
      >
        <div className="editor-heading">
          <label className="editor-title-field">
            <span>TITLE</span>
            <input
              aria-label="Title"
              autoFocus
              disabled={submitting}
              value={value.title}
              onChange={(event) => changeTitle(event.target.value)}
            />
          </label>
          <div className="editor-glyphs">
            {!preview ? <ImageInsert disabled={submitting} onSelect={selectImage} /> : null}
            {!preview && !music ? (
              <MusicAttach disabled={submitting || musicBusy} onSelect={selectMusic} />
            ) : null}
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
              disabled={submitting}
              value={value.markdown}
              onBeforeInput={(event) => {
                pendingInputRange.current = {
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                };
              }}
              onChange={(event) => changeMarkdown(event.target.value)}
              onSelect={() => {
                interactionRevision.current += 1;
              }}
            />
          </label>
        )}

        {music ? (
          <MusicMetadataEditor
            metadata={music}
            candidates={musicCandidates}
            busy={musicBusy || submitting}
            onSave={saveMusicMetadata}
            onSelectCandidate={selectMusicCandidate}
            onCoverSelect={replaceMusicCover}
            onRecognize={recognizeAgain}
          />
        ) : null}
        {musicError ? <p className="editor-error" role="alert">{musicError}</p> : null}
        {error ? <p className="editor-error" role="alert">{error}</p> : null}
        <div className="editor-actions">
          <button type="button" disabled={busy} onClick={cancel}>CANCEL</button>
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
        initialMusic={props.entry.music}
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
      initialMusic={draft?.music}
    />
  );
}
