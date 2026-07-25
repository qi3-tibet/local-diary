# Local Diary Desktop and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the shared local diary as a Windows desktop app and browser launcher, then prove typography, accessibility, 20,000-entry performance, and final release behavior.

**Architecture:** Electron owns process lifecycle and exposes two launch modes: desktop window or server-plus-default-browser. The Fastify service remains loopback-only, the React build remains shared, and packaging includes the open Chinese serif assets plus required media helper binaries.

**Tech Stack:** Electron, electron-builder, Vite, Noto Serif SC, Playwright, Vitest, Axe, Windows installer tooling.

## Global Constraints

- Desktop and browser modes use the same local service, API, web build, data root, and backup root.
- Bind only to `127.0.0.1`.
- Use system Georgia for all English interface text and do not redistribute Georgia.
- Package a redistributable Chinese serif and use it only for Chinese body, title, and music text.
- Follow Windows light/dark mode by default; remember manual override.
- Respect reduced motion.
- Do not introduce an icon library during packaging or accessibility work.
- Support 20,000 entries with responsive search, date jumps, and continuous reading.
- Produce a Windows installer and a browser-mode shortcut.

---

### Task 1: Electron lifecycle and two launch modes

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/service-lifecycle.ts`
- Create: `apps/desktop/src/window.ts`
- Create: `apps/desktop/test/service-lifecycle.test.ts`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Consumes: built server `buildServer()` and built web assets.
- Produces: `startLocalService()`, desktop window mode, and `--browser` mode.

- [ ] **Step 1: Write failing lifecycle tests**

```json
// apps/desktop/package.json
{
  "name": "@diary/desktop",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

```ts
it("starts one loopback service and closes it on app shutdown", async () => {
  const lifecycle = createServiceLifecycle(fakeServerFactory());
  const first = await lifecycle.start();
  const second = await lifecycle.start();
  expect(second.url).toBe(first.url);
  expect(first.host).toBe("127.0.0.1");
  await lifecycle.stop();
  expect(lifecycle.state()).toBe("stopped");
});

it("opens the default browser without creating a desktop window in browser mode", async () => {
  const harness = createDesktopHarness(["--browser"]);
  await harness.run();
  expect(harness.shell.openExternal).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:/));
  expect(harness.windows).toHaveLength(0);
});
```

- [ ] **Step 2: Install Electron and verify lifecycle failures**

Run:

```powershell
pnpm --filter @diary/desktop add -D electron electron-builder
pnpm vitest run apps/desktop/test/service-lifecycle.test.ts
```

Expected: FAIL because desktop lifecycle modules are absent.

- [ ] **Step 3: Implement single-instance service ownership**

```ts
// apps/desktop/src/service-lifecycle.ts
export function createServiceLifecycle(factory = buildServer) {
  let running: { server: ReturnType<typeof factory>; url: string } | null = null;
  return {
    async start() {
      if (running) return { ...running, host: "127.0.0.1" as const };
      const server = factory();
      const address = await server.listen({ host: "127.0.0.1", port: 0 });
      running = { server, url: address };
      return { ...running, host: "127.0.0.1" as const };
    },
    async stop() {
      await running?.server.close();
      running = null;
    },
    state: () => running ? "running" : "stopped",
  };
}
```

```ts
// apps/desktop/src/main.ts
app.requestSingleInstanceLock();
app.whenReady().then(async () => {
  const service = await lifecycle.start();
  if (process.argv.includes("--browser")) {
    await shell.openExternal(service.url);
    return;
  }
  createDiaryWindow(service.url);
});
app.on("before-quit", () => void lifecycle.stop());
```

- [ ] **Step 4: Run desktop lifecycle and workspace verification**

Run:

```powershell
pnpm vitest run apps/desktop/test/service-lifecycle.test.ts
pnpm typecheck
```

Expected: one service instance, no window in browser mode, and clean shutdown.

- [ ] **Step 5: Commit**

```powershell
git add apps/desktop pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat: add desktop and browser launch modes"
```

---

### Task 2: Typography, theme, responsive controls, and accessibility

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/src/styles/app.css`
- Modify: `apps/web/src/theme/theme-store.ts`
- Create: `apps/web/src/a11y/reduced-motion.ts`
- Create: `apps/web/e2e/accessibility.spec.ts`
- Test: `apps/web/src/styles/language-fonts.test.ts`

**Interfaces:**
- Consumes: system theme and reduced-motion media queries.
- Produces: Georgia English UI, packaged Noto Serif SC Chinese content, three-state theme preference, keyboard-complete custom controls.

- [ ] **Step 1: Write failing font-language and accessibility tests**

```ts
it("assigns Chinese serif only to allowed content surfaces", () => {
  expect(readCss(".entry-body")).toContain("--body-cn-font");
  expect(readCss(".entry-title-index")).toContain("--body-cn-font");
  expect(readCss(".music-metadata")).toContain("--body-cn-font");
  expect(readCss(".date-rail")).toContain("--ui-font");
  expect(readCss(".management-action")).toContain("--ui-font");
});
```

```ts
test("has no critical accessibility violations in both themes", async ({ page }) => {
  for (const theme of ["light", "dark"]) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter((item) => item.impact === "critical")).toEqual([]);
  }
});
```

- [ ] **Step 2: Install packaged Chinese font and Axe, then verify failures**

Run:

```powershell
pnpm --filter @diary/web add @fontsource/noto-serif-sc
pnpm --filter @diary/web add -D @axe-core/playwright
pnpm vitest run apps/web/src/styles/language-fonts.test.ts
pnpm exec playwright test apps/web/e2e/accessibility.spec.ts
```

Expected: FAIL because font imports, selector boundaries, and accessible custom controls are incomplete.

- [ ] **Step 3: Implement explicit font boundaries and reduced motion**

```css
@import "@fontsource/noto-serif-sc/400.css";
@import "@fontsource/noto-serif-sc/600.css";

:root {
  --ui-font: Georgia, "Times New Roman", serif;
  --body-cn-font: "Noto Serif SC", "Songti SC", SimSun, serif;
}
body, button, input, textarea, .date-rail, .management-action { font-family: var(--ui-font); }
.entry-body, .entry-title-index, .music-metadata { font-family: var(--body-cn-font); }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
}
```

Every unlabelled geometric control receives an English `aria-label`, visible keyboard focus using ochre, and a 40×40 px minimum target without adding a rounded icon background.

- [ ] **Step 4: Verify fonts, responsive layouts, and accessibility**

Run:

```powershell
pnpm vitest run apps/web/src/styles/language-fonts.test.ts
pnpm exec playwright test apps/web/e2e/accessibility.spec.ts
pnpm --filter @diary/web build
```

Expected: allowed Chinese surfaces use Noto Serif SC, all interface surfaces use Georgia, and no critical Axe violations remain.

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src apps/web/e2e apps/web/package.json pnpm-lock.yaml
git commit -m "feat: finalize typography theme and accessibility"
```

---

### Task 3: 20,000-entry performance and continuous timeline windowing

**Files:**
- Create: `apps/server/test-support/seed-large-diary.ts`
- Modify: `apps/server/src/entries/repository.ts`
- Modify: `apps/server/src/search/routes.ts`
- Create: `apps/web/src/diary/WindowedTimeline.tsx`
- Create: `apps/web/e2e/performance.spec.ts`
- Test: `apps/server/test/performance.test.ts`

**Interfaces:**
- Consumes: paged day API and 20,000-entry fixture.
- Produces: cursor-based day retrieval, timeline windowing that preserves date anchors, measured search/date-jump budgets.

- [ ] **Step 1: Write failing performance budgets**

```ts
it("searches 20,000 entries within 150 ms after warmup", async () => {
  const db = await seedLargeDiary(20_000);
  await repository.search("水滴", 20);
  const started = performance.now();
  const results = repository.search("水滴", 20);
  expect(results.length).toBeGreaterThan(0);
  expect(performance.now() - started).toBeLessThan(150);
});
```

```ts
test("jumps to an old date without mounting 20,000 entry nodes", async ({ page }) => {
  await page.goto("/?fixture=large");
  await page.getByRole("button", { name: "July 26, 2020" }).click();
  await expect(page.locator("#day-2020-07-26")).toBeInViewport();
  expect(await page.locator("article.entry-body").count()).toBeLessThan(250);
});
```

- [ ] **Step 2: Run budgets and verify they fail before indexing/windowing**

Run:

```powershell
pnpm vitest run apps/server/test/performance.test.ts
pnpm exec playwright test apps/web/e2e/performance.spec.ts
```

Expected: search exceeds 150 ms or the browser mounts too many entry nodes.

- [ ] **Step 3: Add cursor paging and day-window preservation**

```ts
export type DayPage = {
  days: Array<{ day: string; entries: Entry[] }>;
  previousCursor: string | null;
  nextCursor: string | null;
};

export function listDayPage(cursor: string | null, direction: "older" | "newer", limitDays = 14): DayPage {
  return repository.selectDayWindow({ cursor, direction, limitDays });
}
```

`WindowedTimeline` keeps the visible day plus seven days on each side, inserts measured spacer blocks for removed day groups, and restores the scroll offset after prepending older days. Intersection observers update the active date rail without rendering all entries.

- [ ] **Step 4: Run performance budgets three times**

Run:

```powershell
1..3 | ForEach-Object { pnpm vitest run apps/server/test/performance.test.ts }
1..3 | ForEach-Object { pnpm exec playwright test apps/web/e2e/performance.spec.ts }
```

Expected: every run keeps warm search below 150 ms and mounted entry nodes below 250.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src apps/server/test apps/server/test-support apps/web/src/diary apps/web/e2e/performance.spec.ts
git commit -m "perf: scale timeline and search to 20000 entries"
```

---

### Task 4: Windows packaging and final release verification

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/assets/app.ico`
- Create: `apps/desktop/assets/fpcalc.exe`
- Create: `apps/desktop/scripts/verify-binaries.mjs`
- Create: `apps/web/e2e/visual.spec.ts`
- Create: `apps/web/e2e/release-flow.spec.ts`
- Create: `docs/release/windows.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: built server, web client, Electron shell, Noto Serif SC assets, verified `fpcalc.exe`.
- Produces: signed-or-local-test Windows installer, desktop shortcut, browser-mode shortcut, screenshots, and release checklist.

- [ ] **Step 1: Write failing packaged-resource and visual tests**

```ts
it("verifies every bundled helper by checksum and executable version", async () => {
  const report = await verifyBundledBinaries();
  expect(report.fpcalc).toMatchObject({ present: true, checksumMatch: true });
  expect(report.fpcalc.version).toMatch(/^fpcalc version /);
});
```

```ts
test("Fine Scale light and dark screens match approved snapshots", async ({ page }) => {
  await page.goto("/?fixture=visual");
  await expect(page).toHaveScreenshot("fine-scale-light.png", { fullPage: true });
  await setTheme(page, "dark");
  await expect(page).toHaveScreenshot("fine-scale-dark.png", { fullPage: true });
});
```

- [ ] **Step 2: Run packaged-resource and visual tests to verify failure**

Run:

```powershell
node apps/desktop/scripts/verify-binaries.mjs
pnpm exec playwright test apps/web/e2e/visual.spec.ts
```

Expected: FAIL until the pinned Chromaprint binary, checksum manifest, and approved visual baselines are present.

- [ ] **Step 3: Configure deterministic Windows packaging**

```yaml
# apps/desktop/electron-builder.yml
appId: com.localdiary.app
productName: Local Diary
files:
  - dist/**
extraResources:
  - from: assets/fpcalc.exe
    to: bin/fpcalc.exe
win:
  target:
    - nsis
  icon: assets/app.ico
nsis:
  oneClick: false
  createDesktopShortcut: true
  createStartMenuShortcut: true
```

The installer adds a second shortcut whose target appends `--browser`. `docs/release/windows.md` records build command, artifact checksum, clean-machine smoke steps, local-data path, backup path, and uninstall behavior. If no signing certificate is configured, mark the artifact as a local test build instead of claiming it is signed.

- [ ] **Step 4: Run the complete release gate**

Run:

```powershell
pnpm test
pnpm typecheck
pnpm -r build
pnpm exec playwright test
node apps/desktop/scripts/verify-binaries.mjs
pnpm --filter @diary/desktop exec electron-builder --win
```

Expected: all tests/builds pass, resource verification exits zero, visual snapshots match, and an NSIS installer is produced under `apps/desktop/dist/`.

- [ ] **Step 5: Commit**

```powershell
git add apps/desktop apps/web/e2e docs/release package.json pnpm-lock.yaml
git commit -m "build: package and verify Local Diary for Windows"
```
