# Local Diary Backup and Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver 30 deduplicated daily snapshots, a self-contained verified archive with atomic restore, and portable Markdown exports with original media.

**Architecture:** Use a content-addressed backup object store plus versioned snapshot manifests. Complete exports materialize a standalone ZIP from one manifest; restore validates into staging and swaps only after a current-data safety snapshot succeeds.

**Tech Stack:** Node.js filesystem APIs, SQLite online backup API, SHA-256, Zod manifests, yazl/yauzl ZIP streaming, Vitest, Playwright.

## Global Constraints

- Run scheduled backup at service startup when today's Beijing snapshot is absent, then once per day while running.
- Retain the newest 30 logical snapshots.
- Deduplicate unchanged original images and MP3 files by content hash.
- Make every retained snapshot independently restorable through its manifest.
- Validate archive version and all checksums before replacing current data.
- Create a safety snapshot immediately before restore.
- Export Markdown for one entry or a Beijing date range with portable relative media paths.
- Never freeze or close the editor during backup/export progress.

---

### Task 1: Deduplicated daily snapshot engine

**Files:**
- Create: `packages/contracts/src/backup.ts`
- Create: `apps/server/src/backup/object-store.ts`
- Create: `apps/server/src/backup/snapshot.ts`
- Create: `apps/server/src/backup/scheduler.ts`
- Modify: `apps/server/src/db/client.ts`
- Test: `apps/server/test/backup-snapshot.test.ts`

**Interfaces:**
- Consumes: database backup stream, media inventory, Beijing day key, backup root.
- Produces: `SnapshotService.create(day)`, `SnapshotService.restore(id, target)`, and `runDailyBackupIfDue()`.

- [ ] **Step 1: Write failing deduplication and retention tests**

```ts
it("creates independently restorable manifests without copying unchanged media twice", async () => {
  const first = await snapshots.create("2026-07-26");
  const objectCount = await objects.count();
  const second = await snapshots.create("2026-07-27");
  expect(await objects.count()).toBe(objectCount + 1); // only the changed database snapshot
  expect(first.objects).toContain(originalImageHash);
  expect(second.objects).toContain(originalImageHash);
});

it("retains the newest 30 Beijing-day snapshots", async () => {
  for (let day = 1; day <= 31; day += 1) await snapshots.create(`2026-07-${String(day).padStart(2, "0")}`);
  expect((await snapshots.list()).map((item) => item.day)).toHaveLength(30);
  expect((await snapshots.list()).at(-1)?.day).toBe("2026-07-31");
});
```

- [ ] **Step 2: Run tests and verify snapshot modules are missing**

Run:

```powershell
pnpm vitest run apps/server/test/backup-snapshot.test.ts
```

Expected: FAIL because object store, manifest, and snapshot service are absent.

- [ ] **Step 3: Implement hashed objects and versioned manifests**

```ts
// packages/contracts/src/backup.ts
export const snapshotManifestSchema = z.object({
  format: z.literal("local-diary-snapshot"),
  version: z.literal(1),
  id: z.string().uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  createdAt: z.string().datetime({ offset: true }),
  databaseObject: z.string().regex(/^[a-f0-9]{64}$/),
  mediaObjects: z.array(z.object({
    logicalPath: z.string().min(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })),
});
```

```ts
// apps/server/src/backup/object-store.ts
export async function putBackupObject(root: string, bytes: Buffer) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const target = join(root, "objects", hash.slice(0, 2), hash);
  await mkdir(dirname(target), { recursive: true });
  try { await writeFile(target, bytes, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return hash;
}
```

- [ ] **Step 4: Verify deduplication, restore, and retention**

Run:

```powershell
pnpm vitest run apps/server/test/backup-snapshot.test.ts
pnpm typecheck
```

Expected: two snapshots share media objects, each restores, and the 31st creation removes only the oldest manifest and unreferenced objects.

- [ ] **Step 5: Commit**

```powershell
git add packages/contracts/src/backup.ts apps/server/src/backup apps/server/src/db apps/server/test/backup-snapshot.test.ts
git commit -m "feat: add deduplicated daily snapshots"
```

---

### Task 2: Complete ZIP archive and safe atomic restore

**Files:**
- Create: `apps/server/src/backup/archive.ts`
- Create: `apps/server/src/backup/restore.ts`
- Create: `apps/server/src/backup/routes.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/archive-restore.test.ts`

**Interfaces:**
- Consumes: a snapshot manifest and backup object store.
- Produces: `exportArchive(snapshotId, output)`, `validateArchive(path)`, `restoreArchive(path)`, and backup routes.

- [ ] **Step 1: Write failing archive corruption and safety tests**

```ts
it("round-trips a standalone archive", async () => {
  const archive = await exportFixtureSnapshot();
  const restored = await restoreIntoEmptyDataRoot(archive);
  expect(await restored.entryCount()).toBe(3);
  expect(await restored.readMedia(originalImageHash)).toEqual(originalImageBytes);
});

it("does not modify current data when a checksum is corrupt", async () => {
  const before = await hashTree(currentDataRoot);
  const corrupt = await corruptOneArchiveObject(await exportFixtureSnapshot());
  await expect(restoreService.restoreArchive(corrupt)).rejects.toThrow("ARCHIVE_CHECKSUM_MISMATCH");
  expect(await hashTree(currentDataRoot)).toBe(before);
});
```

- [ ] **Step 2: Install streaming ZIP dependencies and verify failures**

Run:

```powershell
pnpm --filter @diary/server add yazl yauzl
pnpm --filter @diary/server add -D @types/yazl @types/yauzl
pnpm vitest run apps/server/test/archive-restore.test.ts
```

Expected: FAIL because export and staged restore do not exist.

- [ ] **Step 3: Implement validation-first restore sequence**

```ts
// apps/server/src/backup/restore.ts
export async function restoreArchive(archivePath: string, context: RestoreContext) {
  const staging = await mkdtemp(join(context.temporaryRoot, "restore-"));
  try {
    const manifest = await extractAndValidate(archivePath, staging);
    await verifyAllChecksums(staging, manifest);
    await context.snapshots.createSafetySnapshot();
    await materializeDataRoot(staging, manifest, `${context.dataRoot}.next`);
    await atomicSwapDirectories(context.dataRoot, `${context.dataRoot}.next`);
    await context.rebuildDerivedData();
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
```

The route streams progress events as English states: `VALIDATING`, `SAFETY_BACKUP`, `RESTORING`, `REBUILDING`, `DONE`.

- [ ] **Step 4: Run archive and regression verification**

Run:

```powershell
pnpm vitest run apps/server/test/archive-restore.test.ts apps/server/test/backup-snapshot.test.ts
pnpm vitest run apps/server/test
pnpm typecheck
```

Expected: valid archive round-trips; corrupt archive leaves current data byte-identical.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/backup apps/server/src/app.ts apps/server/test/archive-restore.test.ts pnpm-lock.yaml
git commit -m "feat: add verified archive restore"
```

---

### Task 3: Portable Markdown export

**Files:**
- Create: `apps/server/src/export/markdown.ts`
- Create: `apps/server/src/export/routes.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/markdown-export.test.ts`

**Interfaces:**
- Consumes: one entry ID or inclusive Beijing date range.
- Produces: ZIP containing Markdown front matter and original media under relative `media/` paths.

- [ ] **Step 1: Write failing front-matter and relative-path tests**

```ts
it("exports hidden titles and metadata without absolute media paths", async () => {
  const archive = await exportMarkdown({ from: "2026-07-25", to: "2026-07-26" });
  const markdown = await archive.readText("2026-07-26/2218-rainy-street.md");
  expect(markdown).toContain('title: "雨后的街道"');
  expect(markdown).toContain('published_at: "2026-07-26T22:18:00+08:00"');
  expect(markdown).toContain("song_title: Pink + White");
  expect(markdown).toContain("![rain](media/");
  expect(markdown).not.toMatch(/[A-Z]:\\/);
});
```

- [ ] **Step 2: Run the export test and verify route absence**

Run:

```powershell
pnpm --filter @diary/server add yaml
pnpm vitest run apps/server/test/markdown-export.test.ts
```

Expected: FAIL because Markdown export is not implemented.

- [ ] **Step 3: Implement stable front matter and media rewriting**

```ts
export function entryToPortableMarkdown(entry: ExportEntry, mediaMap: Map<string, string>) {
  const frontMatter = stringifyYaml({
    id: entry.id,
    title: entry.title,
    published_at: entry.publishedAt,
    updated_at: entry.updatedAt,
    tags: entry.tags,
    song_title: entry.music?.title ?? null,
    song_artist: entry.music?.artist ?? null,
    song_album: entry.music?.album ?? null,
  });
  const body = rewriteMediaReferences(entry.markdown, mediaMap);
  return `---\n${frontMatter}---\n\n${body}\n`;
}
```

- [ ] **Step 4: Verify one-entry and date-range exports**

Run:

```powershell
pnpm vitest run apps/server/test/markdown-export.test.ts
pnpm typecheck
```

Expected: exports contain required metadata, original media, and only portable relative paths.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/export apps/server/src/app.ts apps/server/test/markdown-export.test.ts
git commit -m "feat: export portable Markdown archives"
```

---

### Task 4: Backup settings, progress UI, and end-to-end recovery

**Files:**
- Create: `apps/server/src/settings/repository.ts`
- Create: `apps/server/src/settings/routes.ts`
- Create: `apps/web/src/settings/BackupSettings.tsx`
- Create: `apps/web/src/settings/RestoreProgress.tsx`
- Create: `apps/web/e2e/backup-restore.spec.ts`
- Modify: `apps/web/src/app/App.tsx`

**Interfaces:**
- Consumes: backup/export/restore APIs and a user-selected writable directory.
- Produces: remembered backup location, manual backup/export actions, nonblocking English progress, and verified restore.

- [ ] **Step 1: Write the failing recovery browser test**

```ts
test("exports, changes data, and restores the original archive", async ({ page }) => {
  await seedPublishedEntry(page, "Before restore", "Original body");
  const archive = await page.getByRole("button", { name: "Export complete archive" }).click();
  await editFirstEntry(page, "Changed body");
  await chooseRestoreArchive(page, archive);
  await expect(page.getByText("VALIDATING")).toBeVisible();
  await expect(page.getByText("DONE")).toBeVisible();
  await expect(page.getByText("Original body")).toBeVisible();
});

test("shows a persistent recovery action for an unwritable backup location", async ({ page }) => {
  await chooseBackupDirectory(page, unwritableFixturePath);
  await expect(page.getByText("BACKUP LOCATION IS NOT WRITABLE")).toBeVisible();
  await expect(page.getByRole("button", { name: "CHOOSE ANOTHER LOCATION" })).toBeVisible();
  await expect(page.getByLabel("Markdown body")).toBeEditable();
});
```

- [ ] **Step 2: Run the browser test and verify settings UI absence**

Run:

```powershell
pnpm exec playwright test apps/web/e2e/backup-restore.spec.ts
```

Expected: FAIL because backup settings, archive chooser, and progress view are absent.

- [ ] **Step 3: Implement English text settings and streamed progress**

```tsx
export function RestoreProgress({ state }: { state: RestoreState }) {
  return (
    <section aria-live="polite" aria-label="Restore progress">
      <p>{state.phase}</p>
      {state.phase === "FAILED" ? <button onClick={state.retry}>RETRY</button> : null}
    </section>
  );
}
```

Use `showDirectoryPicker()` only in browser environments that support it; otherwise post a server-local path selected through the desktop bridge. Persist the resolved backup root after the server verifies write access.

- [ ] **Step 4: Run complete portability verification**

Run:

```powershell
pnpm test
pnpm typecheck
pnpm --filter @diary/web build
pnpm exec playwright test apps/web/e2e/backup-restore.spec.ts
```

Expected: all tests pass and restore returns the diary to its archived state without blocking the editor UI.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/settings apps/web/src/settings apps/web/src/app apps/web/e2e/backup-restore.spec.ts
git commit -m "feat: add backup and restore experience"
```
