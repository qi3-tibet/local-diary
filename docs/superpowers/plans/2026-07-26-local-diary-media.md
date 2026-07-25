# Local Diary Images and Music Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline original-preserving images and one recognized, editable, continuously playable MP3 to each diary entry.

**Architecture:** Store immutable originals in content-addressed filesystem paths and keep derivatives and metadata in SQLite. Media ingestion is server-owned; the web editor receives stable Markdown references and the reading client streams only the assets it needs.

**Tech Stack:** TypeScript, Fastify multipart, Sharp, music-metadata, Chromaprint `fpcalc`, MusicBrainz/Cover Art Archive adapters, AcoustID-compatible fingerprint adapter, React, TanStack Query, Web Audio/HTMLAudioElement, Vitest, Playwright.

## Global Constraints

- Preserve original image and MP3 bytes.
- Generate one display derivative and one thumbnail for each image.
- Permit multiple images at arbitrary Markdown positions.
- Permit at most one MP3 per entry and render its card after the body.
- Recognition order is ID3, textual online lookup, fingerprint lookup, candidate selection, then manual fallback.
- Recognition failure never prevents attachment or local playback.
- All recognized fields and cover art remain manually editable.
- Do not load MP3 bytes before playback or export.
- Playback continues across day scrolling; floating player exists only while audio is active.

---

### Task 1: Content-addressed media store and image derivatives

**Files:**
- Create: `apps/server/src/media/store.ts`
- Create: `apps/server/src/media/images.ts`
- Create: `apps/server/src/media/routes.ts`
- Modify: `apps/server/src/db/client.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/image-ingestion.test.ts`

**Interfaces:**
- Consumes: application data root and entry IDs.
- Produces: `MediaStore.put(readable, mime)`, `ImageService.ingest(entryId, stream)`, and `POST /api/v1/entries/:id/images`.

- [ ] **Step 1: Write the failing original/derivative test**

```ts
it("retains original bytes and creates display plus thumbnail derivatives", async () => {
  const fixture = await readFile(fixturePath("portrait.jpg"));
  const result = await imageService.ingest(entry.id, Readable.from(fixture), "image/jpeg");
  expect(await readFile(result.originalPath)).toEqual(fixture);
  expect(await sharp(result.displayPath).metadata()).toMatchObject({ width: 1920 });
  expect((await sharp(result.thumbnailPath).metadata()).width).toBe(480);
  expect(result.originalHash).toMatch(/^[a-f0-9]{64}$/);
});

it("keeps the original and records a retryable error when derivative generation fails", async () => {
  const result = await imageService.ingest(entry.id, Readable.from(validButUnsupportedFixture), "image/tiff");
  expect(await readFile(result.originalPath)).toEqual(validButUnsupportedFixture);
  expect(result.derivativeStatus).toBe("failed");
  expect(result.displayPath).toBeNull();
});
```

- [ ] **Step 2: Install image dependencies and verify failure**

Run:

```powershell
pnpm --filter @diary/server add @fastify/multipart sharp
pnpm vitest run apps/server/test/image-ingestion.test.ts
```

Expected: FAIL because media storage and image ingestion modules do not exist.

- [ ] **Step 3: Implement atomic content-addressed storage**

```ts
// apps/server/src/media/store.ts
export class MediaStore {
  constructor(private readonly root: string) {}

  async put(bytes: Buffer, extension: string) {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const target = join(this.root, "objects", hash.slice(0, 2), `${hash}.${extension}`);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx" });
    try { await rename(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await rm(temporary, { force: true });
    }
    return { hash, path: target };
  }
}
```

```ts
// apps/server/src/media/images.ts
const DISPLAY_WIDTH = 1920;
const THUMBNAIL_WIDTH = 480;

export async function deriveImage(original: Buffer) {
  return {
    display: await sharp(original).rotate().resize({ width: DISPLAY_WIDTH, withoutEnlargement: true }).webp({ quality: 86 }).toBuffer(),
    thumbnail: await sharp(original).rotate().resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(),
  };
}
```

- [ ] **Step 4: Verify image ingestion and full server suite**

Run:

```powershell
pnpm vitest run apps/server/test/image-ingestion.test.ts
pnpm vitest run apps/server/test
pnpm typecheck
```

Expected: original checksum matches, both derivatives exist, and server tests pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/media apps/server/src/db apps/server/src/app.ts apps/server/test/image-ingestion.test.ts pnpm-lock.yaml
git commit -m "feat: preserve images and create derivatives"
```

---

### Task 2: Inline Markdown image insertion and lazy reading

**Files:**
- Create: `apps/web/src/editor/ImageInsert.tsx`
- Create: `apps/web/src/editor/insert-at-selection.ts`
- Modify: `apps/web/src/editor/Editor.tsx`
- Modify: `apps/web/src/diary/EntryBody.tsx`
- Test: `apps/web/src/editor/insert-at-selection.test.ts`
- Test: `apps/web/e2e/images.spec.ts`

**Interfaces:**
- Consumes: image upload API response `{ mediaId, markdownUrl, alt }`.
- Produces: `insertAtSelection(textarea, markdown): string` and lazy image renderer.

- [ ] **Step 1: Write failing insertion and browser tests**

```ts
it("inserts the uploaded image at the active Markdown selection", () => {
  expect(insertAtSelection("before after", 7, 7, "![rain](media:image-1)"))
    .toEqual({ value: "before ![rain](media:image-1)after", cursor: 29 });
});
```

```ts
test("keeps two images at their authored body positions", async ({ page }) => {
  await openDraft(page, "Images", "First paragraph.\n\nSecond paragraph.");
  await placeCursorAfter(page, "First paragraph.");
  await uploadImage(page, "portrait.jpg");
  await placeCursorAfter(page, "Second paragraph.");
  await uploadImage(page, "landscape.jpg");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".entry-body img")).toHaveCount(2);
  await expect(page.locator(".entry-body img").first()).toHaveAttribute("loading", "lazy");
});
```

- [ ] **Step 2: Run tests to verify missing insertion behavior**

Run:

```powershell
pnpm vitest run apps/web/src/editor/insert-at-selection.test.ts
pnpm exec playwright test apps/web/e2e/images.spec.ts
```

Expected: both tests fail because upload and custom Markdown media rendering are absent.

- [ ] **Step 3: Implement insertion and stable media URL rendering**

```ts
// apps/web/src/editor/insert-at-selection.ts
export function insertAtSelection(value: string, start: number, end: number, markdown: string) {
  const next = `${value.slice(0, start)}${markdown}${value.slice(end)}`;
  return { value: next, cursor: start + markdown.length };
}
```

```tsx
// custom image component passed to react-markdown
function DiaryImage({ src = "", alt = "" }) {
  const mediaId = src.startsWith("media:") ? src.slice(6) : "";
  return <img src={api.mediaDisplayUrl(mediaId)} alt={alt} loading="lazy" decoding="async" />;
}
```

- [ ] **Step 4: Verify unit, browser, and build results**

Run:

```powershell
pnpm vitest run apps/web/src/editor/insert-at-selection.test.ts
pnpm exec playwright test apps/web/e2e/images.spec.ts
pnpm --filter @diary/web build
```

Expected: insertion preserves cursor order, two images render in authored positions, and build passes.

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/editor apps/web/src/diary apps/web/e2e/images.spec.ts
git commit -m "feat: insert and render inline diary images"
```

---

### Task 3: MP3 ingestion, ID3 metadata, and one-track invariant

**Files:**
- Create: `apps/server/src/music/id3.ts`
- Create: `apps/server/src/music/service.ts`
- Create: `apps/server/src/music/routes.ts`
- Modify: `apps/server/src/db/client.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/server/test/music-id3.test.ts`

**Interfaces:**
- Consumes: MP3 multipart stream and entry ID.
- Produces: `MusicService.attach(entryId, bytes)`, `MusicMetadata`, and `POST/PATCH /entries/:id/music`.

- [ ] **Step 1: Write failing ID3 and one-track tests**

```ts
it("reads embedded song fields and cover without rewriting the MP3", async () => {
  const bytes = await readFile(fixturePath("tagged.mp3"));
  const attached = await musicService.attach(entry.id, bytes);
  expect(attached).toMatchObject({
    title: "Pink + White",
    artist: "Frank Ocean",
    album: "Blonde",
    recognitionStatus: "embedded",
  });
  expect(await readFile(attached.originalPath)).toEqual(bytes);
  await expect(musicService.attach(entry.id, bytes)).rejects.toThrow("ENTRY_ALREADY_HAS_MUSIC");
});
```

- [ ] **Step 2: Install metadata parser and verify failure**

Run:

```powershell
pnpm --filter @diary/server add music-metadata
pnpm vitest run apps/server/test/music-id3.test.ts
```

Expected: FAIL because music schema and service do not exist.

- [ ] **Step 3: Implement ID3 precedence and transactional attachment**

```ts
// apps/server/src/music/id3.ts
export async function readId3(bytes: Buffer): Promise<MusicMetadata> {
  const parsed = await parseBuffer(bytes, { mimeType: "audio/mpeg", size: bytes.length });
  const picture = parsed.common.picture?.[0];
  return {
    title: parsed.common.title ?? null,
    artist: parsed.common.artist ?? null,
    album: parsed.common.album ?? null,
    year: parsed.common.year ?? null,
    coverBytes: picture?.data ?? null,
    coverMime: picture?.format ?? null,
    recognitionStatus: "embedded",
  };
}
```

```sql
CREATE TABLE entry_music (
  entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL UNIQUE,
  title TEXT,
  artist TEXT,
  album TEXT,
  year INTEGER,
  cover_media_id TEXT,
  recognition_status TEXT NOT NULL,
  user_overrides_json TEXT NOT NULL DEFAULT '{}'
);
```

- [ ] **Step 4: Verify ID3, original preservation, and one-track constraint**

Run:

```powershell
pnpm vitest run apps/server/test/music-id3.test.ts
pnpm vitest run apps/server/test
pnpm typecheck
```

Expected: metadata is extracted, bytes are identical, and a second track is rejected.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/music apps/server/src/db packages/contracts apps/server/test/music-id3.test.ts pnpm-lock.yaml
git commit -m "feat: attach one metadata-aware MP3"
```

---

### Task 4: Online text lookup, fingerprint adapter, and manual correction

**Files:**
- Create: `apps/server/src/music/recognition/types.ts`
- Create: `apps/server/src/music/recognition/text-lookup.ts`
- Create: `apps/server/src/music/recognition/fingerprint.ts`
- Create: `apps/server/src/music/recognition/pipeline.ts`
- Modify: `apps/server/src/music/routes.ts`
- Create: `apps/web/src/editor/MusicMetadataEditor.tsx`
- Test: `apps/server/test/music-recognition.test.ts`
- Test: `apps/web/src/editor/MusicMetadataEditor.test.tsx`

**Interfaces:**
- Consumes: partial embedded metadata, filename, MP3 path, optional `ACOUSTID_CLIENT_KEY`.
- Produces: `RecognitionCandidate[]`, explicit candidate selection, manual override patch.

- [ ] **Step 1: Write failing recognition precedence tests**

```ts
it("uses text candidates before fingerprint and keeps manual overrides authoritative", async () => {
  const text = fakeTextLookup([{ id: "mb-1", title: "Song", artist: "Artist", score: 0.96 }]);
  const fingerprint = fakeFingerprintLookup([{ id: "fp-1", title: "Wrong", artist: "Other", score: 0.99 }]);
  const result = await recognizeMusic(partialMetadata(), "song.mp3", text, fingerprint);
  expect(result.candidates[0].id).toBe("mb-1");
  expect(fingerprint.calls).toBe(0);
  expect(applyOverrides(result.candidates[0], { artist: "Corrected" }).artist).toBe("Corrected");
});

it("uses fingerprint after ambiguous text results", async () => {
  const text = fakeTextLookup([{ id: "a", score: 0.62 }, { id: "b", score: 0.61 }]);
  const fingerprint = fakeFingerprintLookup([{ id: "fp", score: 0.98 }]);
  expect((await recognizeMusic(partialMetadata(), "track.mp3", text, fingerprint)).candidates[0].id).toBe("fp");
});
```

- [ ] **Step 2: Run tests to verify missing adapter failures**

Run:

```powershell
pnpm vitest run apps/server/test/music-recognition.test.ts apps/web/src/editor/MusicMetadataEditor.test.tsx
```

Expected: FAIL because recognition interfaces, pipeline, and manual editor are absent.

- [ ] **Step 3: Implement deterministic adapter precedence**

```ts
// apps/server/src/music/recognition/pipeline.ts
const CONFIDENT_TEXT_SCORE = 0.9;

export async function recognizeMusic(
  embedded: PartialMusicMetadata,
  filename: string,
  textLookup: TextLookup,
  fingerprintLookup: FingerprintLookup,
) {
  const textCandidates = await textLookup.search({ embedded, filename });
  if (textCandidates.length === 1 && textCandidates[0].score >= CONFIDENT_TEXT_SCORE) {
    return { source: "text", candidates: textCandidates };
  }
  const fingerprintCandidates = await fingerprintLookup.search();
  return {
    source: fingerprintCandidates.length ? "fingerprint" : "text",
    candidates: fingerprintCandidates.length ? fingerprintCandidates : textCandidates,
  };
}
```

```ts
// apps/server/src/music/recognition/fingerprint.ts
export async function runFpcalc(filePath: string): Promise<{ duration: number; fingerprint: string }> {
  const { stdout } = await execFileAsync(resolveBundledFpcalc(), ["-json", filePath]);
  const parsed = JSON.parse(stdout);
  return { duration: parsed.duration, fingerprint: parsed.fingerprint };
}
```

The production adapter reads `ACOUSTID_CLIENT_KEY` from local configuration. When absent or offline it returns no candidates, records `manual_required`, and never rejects the attachment.

- [ ] **Step 4: Verify precedence, fallback, and manual editor**

Run:

```powershell
pnpm vitest run apps/server/test/music-recognition.test.ts apps/web/src/editor/MusicMetadataEditor.test.tsx
pnpm typecheck
```

Expected: confident text skips fingerprint, ambiguous text invokes fingerprint, missing key yields manual fallback, and overrides win.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/music apps/web/src/editor packages/contracts apps/server/test apps/web/src/editor/MusicMetadataEditor.test.tsx
git commit -m "feat: add music recognition and correction"
```

---

### Task 5: Streamed playback, body-end card, and floating player

**Files:**
- Create: `apps/server/src/media/stream-route.ts`
- Create: `apps/web/src/music/player-store.ts`
- Create: `apps/web/src/music/MusicCard.tsx`
- Create: `apps/web/src/music/FloatingPlayer.tsx`
- Modify: `apps/web/src/diary/EntryBody.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Test: `apps/web/src/music/player-store.test.ts`
- Test: `apps/web/e2e/music-playback.spec.ts`

**Interfaces:**
- Consumes: authenticated loopback range-stream endpoint and entry music metadata.
- Produces: one global audio element, persistent playback state, and body-end music card.

- [ ] **Step 1: Write failing store and browser tests**

```ts
it("keeps the active track when the visible day changes", () => {
  const store = createPlayerStore(fakeAudio());
  store.getState().play(track);
  store.getState().setVisibleDay("2026-07-25");
  expect(store.getState().track?.id).toBe(track.id);
  expect(store.getState().visible).toBe(true);
});
```

```ts
test("continues playback after scrolling to the previous day", async ({ page }) => {
  await seedEntryWithMusic(page);
  await page.getByRole("button", { name: "Play Pink + White" }).click();
  await page.locator("#day-2026-07-25").scrollIntoViewIfNeeded();
  await expect(page.getByRole("region", { name: "Now playing" })).toContainText("Pink + White");
});

test("keeps the entry readable when its stored MP3 is corrupt", async ({ page }) => {
  await seedEntryWithCorruptMusic(page);
  await expect(page.getByText("MEDIA UNAVAILABLE")).toBeVisible();
  await expect(page.locator(".entry-body")).toContainText("咖啡比往常更苦");
});
```

- [ ] **Step 2: Run tests and verify player absence**

Run:

```powershell
pnpm vitest run apps/web/src/music/player-store.test.ts
pnpm exec playwright test apps/web/e2e/music-playback.spec.ts
```

Expected: FAIL because global player, music card, and range streaming are absent.

- [ ] **Step 3: Implement one global audio owner and HTTP range streaming**

```ts
// apps/web/src/music/player-store.ts
export const usePlayerStore = create<PlayerState>((set, get) => ({
  track: null,
  visible: false,
  play: async (track) => {
    const audio = get().audio;
    audio.src = track.streamUrl;
    await audio.play();
    set({ track, visible: true });
  },
  stop: () => {
    get().audio.pause();
    get().audio.removeAttribute("src");
    set({ track: null, visible: false });
  },
  setVisibleDay: () => undefined,
  audio: new Audio(),
}));
```

```tsx
// EntryBody ending
return (
  <article className="entry-body">
    <ReactMarkdown components={markdownComponents}>{entry.markdown}</ReactMarkdown>
    {entry.music ? <MusicCard music={entry.music} /> : null}
  </article>
);
```

- [ ] **Step 4: Run complete media verification**

Run:

```powershell
pnpm test
pnpm typecheck
pnpm --filter @diary/web build
pnpm exec playwright test apps/web/e2e/images.spec.ts apps/web/e2e/music-playback.spec.ts
```

Expected: all media tests pass, music card follows body, and playback survives cross-day scrolling.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/media apps/web/src/music apps/web/src/diary apps/web/src/app apps/web/e2e
git commit -m "feat: add continuous diary music playback"
```
