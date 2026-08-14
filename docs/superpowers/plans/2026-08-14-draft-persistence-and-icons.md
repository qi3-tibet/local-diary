# Draft persistence and Material Symbols implementation plan

> **For implementation:** execute this plan with the selected workflow after the user chooses it.

**Goal:** Persist the current draft before every editor exit (including an Electron window/app close), display the exact persisted state on the next draft entry, and replace the editor/header drawings and labels with locally packaged Material Symbols Rounded filled icons.

**Architecture:** Keep saving ownership inside `EditorForm`, but let it register one async leave function with `App`. `App` awaits that function before changing away from the editor and updates the React Query draft cache with the returned saved draft. The preload/main-process close bridge asks that same registered callback to flush, and only allows Electron to close after a positive acknowledgement. Material Symbols are a local, licensed font asset exposed by a small ligature-based React component; the five header buttons and three editor tools consume that one component.

**Technology:** React 19, TanStack Query, Vitest + Testing Library, Electron context bridge/IPC, Vite local font assets, CSS custom properties.

## Task 1: Make a draft flush return the saved draft and cover the persistence queue

**Files:**
- Modify: `apps/web/src/editor/useSilentDraft.ts`
- Modify: `apps/web/src/editor/useSilentDraft.test.tsx`
- Modify: `apps/web/src/editor/Editor.tsx`
- Create: `apps/web/src/editor/Editor.draft.test.tsx`

### Step 1: Add failing queue tests

Extend `useSilentDraft.test.tsx` so the save mock returns a `DraftInput & { id: string }`, then add tests proving that:

1. `finalize(latest)` waits for an already-running autosave and resolves to the final response, not merely `void`.
2. An unchanged draft does not make a needless request when `finalize` is called.
3. A rejected final request keeps the recovery state as `failed` and rejects the leave promise.

Run: `pnpm --filter @diary/web test -- useSilentDraft.test.tsx`

Expected: the new returned-value and unchanged-finalize assertions fail because the hook currently declares `Promise<void>` and always queues a final save.

### Step 2: Return a coherent result from `useSilentDraft`

Change the hook’s save callback type from `Promise<void>` to `Promise<TSaved>` (using a generic `TSaved extends DraftInput` or the concrete `Entry` type). Track the last successfully persisted `DraftInput` and its saved response. `finalize(value)` must:

```ts
pause();
clearTimeout(timer);
if (sameDraft(value, lastPersisted.current)) return lastSaved.current;
return enqueue(() => persist(value));
```

`persist` must set `lastPersisted.current` and `lastSaved.current` only after the request succeeds; it must keep the existing failed/retrying/recovered behaviour on errors. Keep the serial `pending` chain so an in-flight older autosave completes before the final latest value.

### Step 3: Test the hook again

Run: `pnpm --filter @diary/web test -- useSilentDraft.test.tsx`

Expected: all hook tests pass.

### Step 4: Expose one editor leave operation

Change `EditorProps` so `onCancel` returns `Promise<void>` and add an optional registration callback:

```ts
type EditorProps = {
  entry?: Entry;
  onCancel(): Promise<void>;
  onComplete(entry: Entry): void;
  onRegisterLeave?(leave: () => Promise<boolean>): () => void;
};
```

Within `EditorForm`, create `leaveDraft` that first awaits any image upload and MP3 operation, then calls `draftPersistence.finalize(latestValue.current)`. On success it calls a new `onDraftPersisted(savedDraft)` callback supplied by `Editor`, so React Query can be updated before navigation. It returns `true`; any upload or save failure sets the existing visible error/recovery state and returns `false` without calling `onCancel`.

Use an effect to register `leaveDraft` while a draft form is mounted and clean it up on unmount. Keep the existing Cancel button as a thin caller:

```ts
if (await leaveDraft()) await onCancel();
```

Published-entry editing does not need draft saving: its registered leave function simply returns `true`, preserving current behaviour.

### Step 5: Add an editor-level regression test

In `Editor.draft.test.tsx`, render the draft editor with a QueryClient and mocked `api`. Type text, request a registered leave before the 500 ms timer, resolve `api.saveDraft` with `{ id: "draft-1", ...latest }`, and assert:

- the saved request contains the final text;
- the callback resolves `true` only after that request;
- a failed request resolves `false`, leaves the form mounted, and exposes `DRAFT SAVE FAILED`.

Run: `pnpm --filter @diary/web test -- Editor.draft.test.tsx useSilentDraft.test.tsx`

Expected: new tests pass.

### Step 6: Commit the persistence primitive

```powershell
git add apps/web/src/editor/useSilentDraft.ts apps/web/src/editor/useSilentDraft.test.tsx apps/web/src/editor/Editor.tsx apps/web/src/editor/Editor.draft.test.tsx
git commit -m "fix: flush drafts before leaving editor"
```

## Task 2: Guard every in-app editor route and refresh the returned draft immediately

**Files:**
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/App.navigation.test.tsx`
- Modify: `apps/web/src/editor/Editor.tsx`
- Modify: `apps/web/src/editor/Editor.draft.test.tsx`

### Step 1: Write navigation failure tests

Add tests to `App.navigation.test.tsx` for a draft whose last keystroke has not reached its autosave timer:

1. Clicking Diary, New entry, Search, Trash, and Settings each waits for the registered leave promise before their view appears.
2. A rejected/`false` leave keeps the editor on screen and does not change the chosen destination.
3. Clicking Diary and opening New entry again shows the just-returned draft content immediately, even when its id is unchanged.

Mock the `Editor` registration boundary where appropriate so the app tests assert routing order rather than duplicate editor save tests.

Run: `pnpm --filter @diary/web test -- App.navigation.test.tsx`

Expected: the direct `setView` handlers currently change view immediately, so the ordering and failure tests fail.

### Step 2: Centralize guarded navigation in `App`

Add refs for the mounted editor leave callback and a `leavingEditor` lock. Implement:

```ts
async function leaveEditorThen(action: () => void): Promise<void> {
  if (view !== "editor") return action();
  if (leavingEditor.current) return;
  leavingEditor.current = true;
  try {
    if (await editorLeave.current?.() !== false) action();
  } finally {
    leavingEditor.current = false;
  }
}
```

Use it for `showDiary`, New entry, Search, Trash, Settings, and any existing route that can start from the editor (`openSearchResult`, restore completion). Do not block navigation while the app is not in the editor.

Pass `onRegisterLeave` into `Editor`. Add `onDraftPersisted(savedDraft)` there to call both:

```ts
queryClient.setQueryData(["draft"], savedDraft);
await queryClient.invalidateQueries({ queryKey: ["draft"] });
```

Change the draft form key to include a persisted revision derived from the query data (for example `draft?.updatedAt ?? draft?.id ?? "new-draft"`) and keep its initial state reset only when that key changes. This fixes the same-id stale form case without overwriting a currently typed draft during a background refetch.

### Step 3: Re-run focused web tests

Run: `pnpm --filter @diary/web test -- App.navigation.test.tsx Editor.draft.test.tsx Editor.preview.test.tsx`

Expected: all focused navigation/editor tests pass.

### Step 4: Commit guarded routing

```powershell
git add apps/web/src/app/App.tsx apps/web/src/app/App.navigation.test.tsx apps/web/src/editor/Editor.tsx apps/web/src/editor/Editor.draft.test.tsx
git commit -m "fix: preserve drafts across app navigation"
```

## Task 3: Flush through the Electron close lifecycle before stopping the local service

**Files:**
- Modify: `apps/desktop/src/preload.cts`
- Modify: `apps/desktop/src/window.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/test/window.test.ts`
- Modify: `apps/desktop/test/service-lifecycle.test.ts`
- Modify: `apps/web/src/settings/BackupSettings.tsx`
- Create: `apps/web/src/desktop/close-bridge.ts`
- Create: `apps/web/src/desktop/close-bridge.test.tsx`

### Step 1: Add failing desktop and renderer bridge tests

Test that a BrowserWindow `close` event is prevented on first request, emits a renderer `diary:flush-before-close` request, and only retries the native close after an allowed acknowledgement. Add a negative case where `ok: false` leaves the native window open.

In the renderer bridge test, register an async callback, dispatch the exposed desktop event, and assert it sends `true` only after the callback resolves and `false` when it rejects. Also assert disposing the listener prevents later calls.

Run: `pnpm --filter @diary/desktop test -- window.test.ts service-lifecycle.test.ts && pnpm --filter @diary/web test -- close-bridge.test.tsx`

Expected: tests fail because neither close channel nor renderer API exists.

### Step 2: Add a minimal, allow-listed preload API

In `preload.cts`, keep `chooseBackupDirectory` and add only:

```ts
onFlushBeforeClose(listener: () => Promise<boolean>): () => void
```

The implementation subscribes to `diary:flush-before-close`, awaits the one registered listener, and sends `diary:flush-before-close:result` with `{ ok }`; errors become `{ ok: false }`. It must expose no raw `ipcRenderer`, no event object, and remove the IPC subscription when the returned cleanup function is called.

Move the shared `window.diaryDesktop` declaration out of `BackupSettings.tsx` into `apps/web/src/desktop/close-bridge.ts` (or a dedicated `desktop-window.d.ts`) so the backup and close methods are typed together. The bridge React hook/effect registers the `App` leave callback only when desktop API exists.

### Step 3: Add the main-process close coordinator

Extend `WindowRuntime` with the specific Electron methods required for close coordination: `on("close", ...)`, `close()`, `webContents.send`, and `ipcMain.on/removeListener` via an injected close-bridge runtime. Keep `createDiaryWindow` responsible for creating and disposing its per-window coordinator.

The coordinator rules are:

1. First native close: `event.preventDefault()`, mark `flushInProgress`, and send `diary:flush-before-close`.
2. Renderer result `{ ok: true }`: mark `closeAllowed`, call `window.close()`, and let its next close event proceed.
3. Result `{ ok: false }`, destroyed window, duplicate close, or missing renderer response: clear `flushInProgress` and leave the window open. Use a bounded timeout so a broken renderer never hangs indefinitely.
4. Dispose IPC listeners when the window is closed/destroyed.

Refactor `createDesktopHarness` so its `before-quit` flow waits for the managed BrowserWindow’s close promise before `lifecycle.stop()`. The guard against the second `app.quit()` must remain, ensuring service shutdown happens only after the draft flush. `window-all-closed` still requests quit, but it now passes through the same ordering.

### Step 4: Connect the app callback

In `App`, subscribe to `window.diaryDesktop.onFlushBeforeClose`. Its listener calls the same guarded editor leave function (or resolves `true` outside the editor). Return `false` if a draft upload/save fails; do not call navigation for a close request. Clean up the listener on unmount.

### Step 5: Run desktop and bridge tests

Run: `pnpm --filter @diary/desktop test -- window.test.ts service-lifecycle.test.ts && pnpm --filter @diary/web test -- close-bridge.test.tsx App.navigation.test.tsx`

Expected: tests pass, including the assertion that the service does not stop until the renderer has acknowledged a successful flush.

### Step 6: Commit the close handshake

```powershell
git add apps/desktop/src/main.ts apps/desktop/src/window.ts apps/desktop/src/preload.cts apps/desktop/test/window.test.ts apps/desktop/test/service-lifecycle.test.ts apps/web/src/desktop apps/web/src/settings/BackupSettings.tsx apps/web/src/app/App.tsx
git commit -m "fix: save drafts before desktop shutdown"
```

## Task 4: Package Material Symbols Rounded Filled and replace all specified controls

**Files:**
- Add: `apps/web/src/assets/fonts/MaterialSymbolsRounded.woff2`
- Add: `apps/web/src/assets/fonts/LICENSE-Material-Symbols.txt`
- Create: `apps/web/src/icons/MaterialSymbol.tsx`
- Create: `apps/web/src/icons/MaterialSymbol.test.tsx`
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/src/styles/language-fonts.test.ts`
- Modify: `apps/web/src/styles/app.css`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/editor/ImageInsert.tsx`
- Modify: `apps/web/src/editor/MusicAttach.tsx`
- Modify: `apps/web/src/editor/ModeGlyph.tsx`
- Modify: `apps/web/src/editor/ImageInsert.test.tsx`
- Modify: `apps/web/src/editor/MusicAttach.test.tsx`
- Modify: `apps/web/src/editor/Editor.preview.test.tsx`

### Step 1: Add failing semantic/icon tests

Write `MaterialSymbol.test.tsx` to assert that a symbol renders its ligature name as hidden text inside a span with `aria-hidden="true"`, and has no standalone accessible name. Update existing component tests to assert the actual requested symbol labels:

- Header: `home`, `edit_square`, `search`, `delete`, `settings`.
- Editor: `add_photo_alternate`, `library_music`, `visibility`.

Assert header buttons retain English `aria-label` and `title`, only the active view has `aria-current="page"`, and the preview button remains `aria-pressed`.

Extend `language-fonts.test.ts` to require the local Material Symbols `@font-face`, the `.woff2` asset, and its Apache 2.0 license file.

Run: `pnpm --filter @diary/web test -- MaterialSymbol.test.tsx ImageInsert.test.tsx MusicAttach.test.tsx Editor.preview.test.tsx language-fonts.test.ts`

Expected: these assertions fail before the local asset/component is added.

### Step 2: Add official local assets and one icon primitive

Obtain the Material Symbols Rounded variable font from Google’s official Material Symbols distribution and save the font plus its Apache 2.0 licence text under the paths above. Do not load Google Fonts at runtime and do not add a remote request.

Declare it in `tokens.css` with the filled axis locked:

```css
@font-face {
  font-family: "Material Symbols Rounded";
  src: url("../assets/fonts/MaterialSymbolsRounded.woff2") format("woff2");
  font-style: normal;
  font-weight: 100 700;
  font-display: block;
}
```

Create the small `MaterialSymbol` component:

```tsx
export function MaterialSymbol({ name, className }: { name: string; className?: string }) {
  return <span aria-hidden="true" className={`material-symbol${className ? ` ${className}` : ""}`}>{name}</span>;
}
```

Style `.material-symbol` with `font-family: "Material Symbols Rounded"`, `font-variation-settings: "FILL" 1, "wght" 500, "GRAD" 0, "opsz" 24`, `line-height: 1`, and `speak: never`.

### Step 3: Replace controls and simplify obsolete drawings

Replace the text children of the five `.workspace-tools` buttons with the mapped `MaterialSymbol` values. Add `title` equal to the current English `aria-label`; preserve `disabled`, click behaviour, and restore locking. Use `aria-current="page"` only for the selected view.

Replace image, music, and preview children with the mapped `MaterialSymbol` values. Preserve native file inputs, busy/disabled states, preview mode’s existing rule that hides image/music controls, and the existing accessible labels.

Delete only the CSS that drew the old nested spans (`.image-glyph-frame`, `.image-glyph-mark`, `.music-note-*`, `.glyph-square*`). Keep or rename the button layout classes to protect dimensions and focus behaviour. Update styles so icon buttons have a 40 px hit target, muted `--muted` default colour, `--ink` on hover/focus, and `--ochre` only for `[aria-current="page"]`. Ensure the existing `[data-theme="dark"]` variables supply the dark-mode colours automatically.

### Step 4: Run focused UI checks

Run: `pnpm --filter @diary/web test -- MaterialSymbol.test.tsx ImageInsert.test.tsx MusicAttach.test.tsx Editor.preview.test.tsx language-fonts.test.ts app.test.ts && pnpm --filter @diary/web build`

Expected: all tests and web build pass; Vite includes the local font in output and makes no Google Fonts request.

### Step 5: Commit the visual update

```powershell
git add apps/web/src/assets/fonts/MaterialSymbolsRounded.woff2 apps/web/src/assets/fonts/LICENSE-Material-Symbols.txt apps/web/src/icons apps/web/src/styles/tokens.css apps/web/src/styles/app.css apps/web/src/styles/language-fonts.test.ts apps/web/src/app/App.tsx apps/web/src/editor
git commit -m "feat: use material icons in diary controls"
```

## Task 5: Verify the integrated app, manually check both themes, and prepare handoff

**Files:**
- Modify only if verification exposes a defect in the scoped files above.

### Step 1: Run the full automated suite

Run:

```powershell
pnpm test
pnpm typecheck
pnpm --filter @diary/web build
pnpm --filter @diary/desktop build
```

Expected: all commands exit successfully.

### Step 2: Perform a local interaction check

Start the desktop app in development, then verify:

1. Type in a new draft and immediately click each header destination; reopen New entry and confirm the exact text is present on the first return.
2. With a fresh unsaved keystroke, close the application window; relaunch and confirm the exact text is present.
3. Temporarily simulate a save failure and confirm that route changes and window close are blocked while the recovery message remains visible.
4. Inspect light and dark themes: all eight icons are filled Material Symbols, hover/focus is legible, only the active header page is ochre, and tooltips remain English.

### Step 3: Inspect the change set and commit any verification fix

Run:

```powershell
git status --short
git diff --check
git log --oneline -4
```

Do not stage `.firecrawl/` or `.superpowers/` visual-session files. If a verification-only fix was required, stage only its scoped source/test files and commit it as `fix: verify draft persistence and icon controls`.

### Step 4: Report completion

Report the tests run, the direct close-flow verification result, and the final commits. Do not build an installer, change the app version, create a release, or push to GitHub unless the user explicitly asks for that release step.
