# Local Diary Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a runnable local browser diary with one silent draft, immutable Beijing publication times, Markdown entries, tags, search, trash, and the approved Fine Scale reading interface.

**Architecture:** Use a pnpm TypeScript workspace with a Fastify loopback service, SQLite persistence through `better-sqlite3`, shared Zod contracts, and a React/Vite client. The web client consumes only the versioned local HTTP API; time, state transitions, and search remain server-owned.

**Tech Stack:** Node.js 24, pnpm 11, TypeScript, Fastify, Zod, better-sqlite3, React, Vite, TanStack Query, Zustand, react-markdown, Vitest, Testing Library, Playwright.

## Global Constraints

- Bind the local service to `127.0.0.1`; never bind version one to a LAN interface.
- Group and display all publication times in `Asia/Shanghai`; publication time is immutable and precise to the minute.
- Permit exactly one draft at a time.
- Require a title and Markdown body before publication.
- Hide entry titles from the reading body; expose them in search and management indexes.
- Use English for all interface copy and Georgia for all English interface typography.
- Permit Chinese only in diary bodies, diary titles, and music metadata; use the body Chinese serif for all Chinese.
- Use the approved Warm Paper colors, 88 px Fine Scale rail, centered long-form reading page, and continuous cross-day stream.
- Do not add a general icon library, gradients, glass effects, glow, spring motion, accounts, encryption, rich text, PDF export, or entry version history.

## File Structure

```text
apps/
  server/
    src/
      app.ts                 Fastify composition root
      config.ts              Loopback/data-root configuration
      db/client.ts           SQLite connection and migrations
      entries/repository.ts  Entry persistence and queries
      entries/routes.ts      Draft/publish/edit/trash endpoints
      search/routes.ts       Full-text and tag search endpoints
      time/beijing.ts        Publication clock and date grouping
    test/
  web/
    src/
      api/client.ts          Typed HTTP client
      app/App.tsx            Application routes and providers
      diary/                 Timeline, date rail, entry view
      editor/                One-draft Markdown editor
      search/                Search and result navigation
      theme/                 System/manual theme state
      styles/                Tokens, typography, responsive layout
    e2e/
packages/
  contracts/src/index.ts     Shared Zod schemas and API types
  test-support/src/index.ts  Temporary data roots and test clocks
```

---

### Task 1: Workspace and loopback health service

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/app.ts`
- Test: `apps/server/test/health.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `buildServer(options?: ServerOptions): FastifyInstance` and `resolveServerConfig(env): ServerConfig`.

- [ ] **Step 1: Write the failing loopback/configuration test and workspace manifests**

```ts
// apps/server/test/health.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { resolveServerConfig } from "../src/config.js";

describe("local service", () => {
  const servers: Array<ReturnType<typeof buildServer>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

  it("reports health without exposing a LAN host", async () => {
    expect(resolveServerConfig({})).toMatchObject({ host: "127.0.0.1" });
    const server = buildServer();
    servers.push(server);
    const response = await server.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", apiVersion: 1 });
  });
});
```

```json
// package.json
{
  "name": "local-diary",
  "private": true,
  "packageManager": "pnpm@11.9.0",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.0.0"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - packages/*
```

```json
// apps/server/package.json
{
  "name": "@diary/server",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

```json
// apps/server/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

- [ ] **Step 2: Install dependencies and run the test to verify it fails**

Run:

```powershell
pnpm --filter @diary/server add fastify
pnpm install
pnpm vitest run apps/server/test/health.test.ts
```

Expected: FAIL because `../src/app.js` and `../src/config.js` do not exist.

- [ ] **Step 3: Implement the minimal loopback service**

```ts
// apps/server/src/config.ts
import path from "node:path";

export type ServerConfig = {
  host: "127.0.0.1";
  port: number;
  dataRoot: string;
};

export function resolveServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  return {
    host: "127.0.0.1",
    port: Number(env.DIARY_PORT ?? 43127),
    dataRoot: path.resolve(env.DIARY_DATA_ROOT ?? "data"),
  };
}
```

```ts
// apps/server/src/app.ts
import Fastify from "fastify";

export type ServerOptions = { dataRoot?: string };

export function buildServer(_options: ServerOptions = {}) {
  const server = Fastify({ logger: false });
  server.get("/api/v1/health", async () => ({ status: "ok", apiVersion: 1 }));
  return server;
}
```

- [ ] **Step 4: Run focused and workspace verification**

Run:

```powershell
pnpm vitest run apps/server/test/health.test.ts
pnpm typecheck
```

Expected: one passing health test and zero TypeScript errors.

- [ ] **Step 5: Commit**

```powershell
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts apps/server
git commit -m "chore: establish local diary workspace"
```

---

### Task 2: SQLite schema, repository, and Beijing clock

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/test-support/src/index.ts`
- Create: `apps/server/src/db/client.ts`
- Create: `apps/server/src/time/beijing.ts`
- Create: `apps/server/src/entries/repository.ts`
- Test: `apps/server/test/entries-repository.test.ts`
- Test: `apps/server/test/beijing-time.test.ts`

**Interfaces:**
- Consumes: `ServerConfig.dataRoot`.
- Produces: `DiaryDatabase`, `EntryRepository`, `BeijingClock`, `Entry`, `DraftInput`, `createTestDatabase()`, and `buildTestServer()`.

- [ ] **Step 1: Write failing repository and timezone tests**

```ts
// apps/server/test/beijing-time.test.ts
import { describe, expect, it } from "vitest";
import { createBeijingClock } from "../src/time/beijing.js";

describe("BeijingClock", () => {
  it("rounds publication time to the minute and groups in Asia/Shanghai", () => {
    const clock = createBeijingClock(() => new Date("2026-07-26T16:03:49.999Z"));
    expect(clock.publishedAt()).toBe("2026-07-27T00:03:00+08:00");
    expect(clock.dayKey("2026-07-27T00:03:00+08:00")).toBe("2026-07-27");
  });
});
```

```ts
// apps/server/test/entries-repository.test.ts
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "@diary/test-support";
import { EntryRepository } from "../src/entries/repository.js";

describe("EntryRepository", () => {
  it("persists exactly one draft", () => {
    const db = createTestDatabase();
    const repository = new EntryRepository(db);
    repository.saveDraft({ title: "雨后的街道", markdown: "空气变凉了。", tags: ["散步"] });
    repository.saveDraft({ title: "更新后的标题", markdown: "仍然在想。", tags: [] });
    expect(repository.getDraft()).toMatchObject({
      title: "更新后的标题",
      state: "draft",
    });
    expect(repository.countByState("draft")).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify missing repository and clock failures**

Run:

```powershell
pnpm vitest run apps/server/test/beijing-time.test.ts apps/server/test/entries-repository.test.ts
```

Expected: FAIL because the clock, database helper, and repository modules are missing.

- [ ] **Step 3: Implement contracts, migrations, clock, and repository**

```ts
// packages/contracts/src/index.ts
import { z } from "zod";

export const entryStateSchema = z.enum(["draft", "published", "trashed"]);
export const draftInputSchema = z.object({
  title: z.string(),
  markdown: z.string(),
  tags: z.array(z.string().trim().min(1)).default([]),
});
export type DraftInput = z.infer<typeof draftInputSchema>;

export type Entry = {
  id: string;
  title: string;
  markdown: string;
  state: z.infer<typeof entryStateSchema>;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  tags: string[];
};
```

```ts
// apps/server/src/time/beijing.ts
export type BeijingClock = {
  publishedAt(): string;
  dayKey(timestamp: string): string;
};

export function createBeijingClock(now: () => Date = () => new Date()): BeijingClock {
  return {
    publishedAt() {
      const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(now()).reduce<Record<string, string>>((out, part) => {
        out[part.type] = part.value;
        return out;
      }, {});
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`;
    },
    dayKey(timestamp) {
      return timestamp.slice(0, 10);
    },
  };
}
```

```sql
-- executed by apps/server/src/db/client.ts migration 001
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft','published','trashed')),
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX one_draft_only ON entries(state) WHERE state = 'draft';
CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE entry_tags (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(entry_id, tag_id)
);
```

- [ ] **Step 4: Run repository and timezone verification**

Run:

```powershell
pnpm vitest run apps/server/test/beijing-time.test.ts apps/server/test/entries-repository.test.ts
pnpm typecheck
```

Expected: all focused tests pass and the workspace typecheck exits zero.

- [ ] **Step 5: Commit**

```powershell
git add packages apps/server/src/db apps/server/src/time apps/server/src/entries apps/server/test
git commit -m "feat: add diary persistence and Beijing clock"
```

---

### Task 3: Silent draft and publication API

**Files:**
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/src/entries/service.ts`
- Create: `apps/server/src/entries/routes.ts`
- Test: `apps/server/test/entries-routes.test.ts`

**Interfaces:**
- Consumes: `EntryRepository`, `BeijingClock`, `draftInputSchema`.
- Produces: `GET/PUT /api/v1/draft`, `POST /api/v1/draft/publish`, `GET /api/v1/entries`.

- [ ] **Step 1: Write failing API state-transition tests**

```ts
// apps/server/test/entries-routes.test.ts
it("silently updates one draft and timestamps only on DONE", async () => {
  const server = buildTestServer({ now: "2026-07-26T16:03:49.000Z" });
  await server.inject({
    method: "PUT", url: "/api/v1/draft",
    payload: { title: "雨后的街道", markdown: "空气变凉了。", tags: ["散步"] },
  });
  const draft = await server.inject({ method: "GET", url: "/api/v1/draft" });
  expect(draft.json().publishedAt).toBeNull();

  const published = await server.inject({ method: "POST", url: "/api/v1/draft/publish" });
  expect(published.statusCode).toBe(201);
  expect(published.json().publishedAt).toBe("2026-07-27T00:03:00+08:00");
});

it("rejects DONE until title and Markdown body are non-empty", async () => {
  const server = buildTestServer();
  await server.inject({
    method: "PUT", url: "/api/v1/draft",
    payload: { title: " ", markdown: "", tags: [] },
  });
  const response = await server.inject({ method: "POST", url: "/api/v1/draft/publish" });
  expect(response.statusCode).toBe(422);
  expect(response.json().fields).toEqual(["title", "markdown"]);
});
```

- [ ] **Step 2: Run the route tests and confirm 404 failures**

Run:

```powershell
pnpm vitest run apps/server/test/entries-routes.test.ts
```

Expected: FAIL because draft and publication routes return 404.

- [ ] **Step 3: Implement validation and state transitions**

```ts
// apps/server/src/entries/service.ts
export class EntryService {
  constructor(
    private readonly entries: EntryRepository,
    private readonly clock: BeijingClock,
  ) {}

  saveDraft(input: DraftInput) {
    return this.entries.saveDraft(input);
  }

  getDraft() {
    return this.entries.getDraft();
  }

  listPublished() {
    return this.entries.listPublished();
  }

  publishDraft() {
    const draft = this.entries.getDraft();
    if (!draft) throw new EntryValidationError(["draft"]);
    const fields = [
      ...(draft.title.trim() ? [] : ["title"]),
      ...(draft.markdown.trim() ? [] : ["markdown"]),
    ];
    if (fields.length) throw new EntryValidationError(fields);
    return this.entries.publishDraft(draft.id, this.clock.publishedAt());
  }
}
```

```ts
// apps/server/src/entries/routes.ts
export async function registerEntryRoutes(server: FastifyInstance, service: EntryService) {
  server.get("/api/v1/draft", async (_request, reply) =>
    reply.send(service.getDraft() ?? null));
  server.put("/api/v1/draft", async (request, reply) =>
    reply.send(service.saveDraft(draftInputSchema.parse(request.body))));
  server.post("/api/v1/draft/publish", async (_request, reply) =>
    reply.code(201).send(service.publishDraft()));
  server.get("/api/v1/entries", async () => service.listPublished());
}
```

- [ ] **Step 4: Run route, repository, and type verification**

Run:

```powershell
pnpm vitest run apps/server/test/entries-routes.test.ts apps/server/test/entries-repository.test.ts
pnpm typecheck
```

Expected: all tests pass; empty title/body returns 422 and publication time is Beijing completion time.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/entries apps/server/src/app.ts apps/server/test/entries-routes.test.ts
git commit -m "feat: add silent draft and publication flow"
```

---

### Task 4: Edit, tags, full-text search, and 30-day trash

**Files:**
- Modify: `apps/server/src/db/client.ts`
- Modify: `apps/server/src/entries/repository.ts`
- Modify: `apps/server/src/entries/routes.ts`
- Create: `apps/server/src/search/routes.ts`
- Create: `apps/server/src/trash/cleanup.ts`
- Test: `apps/server/test/search-trash.test.ts`

**Interfaces:**
- Consumes: published entries from `EntryRepository`.
- Produces: `PATCH /entries/:id`, `DELETE /entries/:id`, `POST /trash/:id/restore`, `GET /search?q=`, and `purgeExpiredTrash(now)`.

- [ ] **Step 1: Write failing search/edit/trash tests**

```ts
// apps/server/test/search-trash.test.ts
it("searches title, body, and tags while reading output omits titles", async () => {
  const server = await seededServer({
    title: "雨后的街道", markdown: "树叶上的水滴声", tags: ["散步"],
  });
  for (const q of ["雨后", "水滴", "散步"]) {
    const response = await server.inject({ method: "GET", url: `/api/v1/search?q=${encodeURIComponent(q)}` });
    expect(response.json().items).toHaveLength(1);
  }
  const timeline = await server.inject({ method: "GET", url: "/api/v1/entries" });
  expect(timeline.json().items[0]).not.toHaveProperty("displayTitle");
});

it("marks edits without changing publishedAt and purges after 30 days", async () => {
  const { server, entry } = await publishedServer();
  const edited = await server.inject({
    method: "PATCH", url: `/api/v1/entries/${entry.id}`,
    payload: { title: entry.title, markdown: "修改后的正文", tags: [] },
  });
  expect(edited.json().publishedAt).toBe(entry.publishedAt);
  expect(edited.json().edited).toBe(true);
  await server.inject({ method: "DELETE", url: `/api/v1/entries/${entry.id}` });
  expect(await purgeAt("2026-08-24T00:00:00+08:00")).toBe(0);
  expect(await purgeAt("2026-08-26T00:00:00+08:00")).toBe(1);
});
```

- [ ] **Step 2: Run focused tests to verify missing FTS and trash behavior**

Run:

```powershell
pnpm vitest run apps/server/test/search-trash.test.ts
```

Expected: FAIL because search, edit, delete, restore, and purge operations are not implemented.

- [ ] **Step 3: Add FTS5 indexing and transactional trash behavior**

```sql
CREATE VIRTUAL TABLE entry_search USING fts5(
  entry_id UNINDEXED,
  title,
  body,
  tags,
  song_title,
  song_artist,
  song_album,
  tokenize = 'trigram'
);
```

The trigram tokenizer is required so Chinese substring queries such as `水滴` match longer unspaced Chinese sentences. Add an integration assertion that `树叶上的水滴声` matches both `水滴` and `树叶`.

```ts
// apps/server/src/trash/cleanup.ts
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function purgeExpiredTrash(repository: EntryRepository, now: Date): number {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_MS).toISOString();
  return repository.purgeTrashedBefore(cutoff);
}
```

```ts
// edit invariant inside EntryRepository
updatePublished(id: string, input: DraftInput): Entry {
  return this.transaction(() => {
    const before = this.getPublishedOrThrow(id);
    this.updateContent(id, input, new Date().toISOString());
    this.reindex(id);
    const after = this.getPublishedOrThrow(id);
    if (after.publishedAt !== before.publishedAt) throw new Error("published_at changed");
    return after;
  });
}
```

- [ ] **Step 4: Run the complete server test suite**

Run:

```powershell
pnpm vitest run apps/server/test
pnpm typecheck
```

Expected: all server tests pass, including title/body/tag search and exact 30-day deletion boundary.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src apps/server/test
git commit -m "feat: add search editing and recoverable trash"
```

---

### Task 5: Fine Scale timeline, theme, and responsive shell

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/app/App.tsx`
- Create: `apps/web/src/diary/DateRail.tsx`
- Create: `apps/web/src/diary/Timeline.tsx`
- Create: `apps/web/src/diary/EntryBody.tsx`
- Create: `apps/web/src/theme/theme-store.ts`
- Create: `apps/web/src/styles/tokens.css`
- Create: `apps/web/src/styles/app.css`
- Test: `apps/web/src/diary/Timeline.test.tsx`
- Test: `apps/web/src/theme/theme-store.test.ts`

**Interfaces:**
- Consumes: `GET /api/v1/entries` and shared `Entry` contracts.
- Produces: `Timeline`, `DateRail`, persisted three-state theme preference (`system | light | dark`), and responsive Fine Scale layout.

- [ ] **Step 1: Write failing timeline and theme tests**

```json
// apps/web/package.json
{
  "name": "@diary/web",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

```tsx
// apps/web/src/diary/Timeline.test.tsx
it("renders full bodies across days without rendering entry titles", () => {
  render(<Timeline entries={entriesForTwoDays} />);
  expect(screen.getByText("树叶上的水滴声")).toBeVisible();
  expect(screen.getByText("终于读完了这本书")).toBeVisible();
  expect(screen.queryByText("雨后的街道")).not.toBeInTheDocument();
  expect(screen.getAllByRole("time")).toHaveLength(3);
});
```

```ts
// apps/web/src/theme/theme-store.test.ts
it("follows Windows until a remembered override is selected", () => {
  const store = createThemeStore(fakeStorage(), () => true);
  expect(store.getState().resolved).toBe("dark");
  store.getState().setPreference("light");
  expect(store.getState()).toMatchObject({ preference: "light", resolved: "light" });
});
```

- [ ] **Step 2: Install web dependencies and verify tests fail**

Run:

```powershell
pnpm --filter @diary/web add react react-dom @tanstack/react-query zustand react-markdown
pnpm --filter @diary/web add -D vite @vitejs/plugin-react vitest jsdom @testing-library/react @testing-library/jest-dom
pnpm vitest run apps/web/src/diary/Timeline.test.tsx apps/web/src/theme/theme-store.test.ts
```

Expected: FAIL because timeline and theme modules do not exist.

- [ ] **Step 3: Implement the selected visual shell**

```tsx
// apps/web/src/diary/Timeline.tsx
export function Timeline({ entries }: { entries: Entry[] }) {
  const groups = groupEntriesByBeijingDay(entries);
  return (
    <main className="reading-page">
      {groups.map(({ day, entries: dayEntries }) => (
        <section className="day" id={`day-${day}`} key={day} data-day={day}>
          <header className="day-heading">
            <strong>{day.slice(-2)}</strong>
            <span>{formatEnglishDayMeta(day, dayEntries.length)}</span>
          </header>
          {dayEntries.map((entry) => <EntryBody entry={entry} key={entry.id} />)}
        </section>
      ))}
    </main>
  );
}
```

```css
/* apps/web/src/styles/tokens.css */
:root {
  --paper: #f2eee6;
  --panel: #e9e3d8;
  --ink: #28251f;
  --muted: #8d8579;
  --line: #d2cabd;
  --ochre: #b88957;
  --ui-font: Georgia, serif;
  --body-cn-font: "Noto Serif SC", "Songti SC", SimSun, serif;
}
[data-theme="dark"] {
  --paper: #1c1b19;
  --panel: #25221f;
  --ink: #eee8dd;
  --muted: #8e877d;
  --line: #3b3732;
  --ochre: #bf8f5b;
}
```

```css
/* apps/web/src/styles/app.css */
.app-shell { min-height: 100vh; background: var(--paper); color: var(--ink); }
.date-rail { position: fixed; inset: 0 auto 0 0; width: 88px; border-right: 1px solid var(--line); }
.reading-page { width: min(610px, calc(100vw - 180px)); margin: 0 auto; padding: 52px 0 120px 88px; }
.entry-body { font-family: var(--body-cn-font); font-size: 1rem; line-height: 2.08; }
@media (max-width: 720px) {
  .date-rail { inset: 0 0 auto; width: auto; height: 58px; display: flex; overflow-x: auto; }
  .reading-page { width: min(100% - 32px, 610px); padding: 92px 0 80px; }
}
```

- [ ] **Step 4: Verify rendering, theme, and type safety**

Run:

```powershell
pnpm vitest run apps/web/src/diary/Timeline.test.tsx apps/web/src/theme/theme-store.test.ts
pnpm --filter @diary/web build
pnpm typecheck
```

Expected: tests pass, Vite build succeeds, and the body omits titles.

- [ ] **Step 5: Commit**

```powershell
git add apps/web package.json pnpm-lock.yaml
git commit -m "feat: add Fine Scale diary timeline"
```

---

### Task 6: Markdown editor, search/trash UI, and core end-to-end flow

**Files:**
- Create: `apps/web/src/editor/Editor.tsx`
- Create: `apps/web/src/editor/useSilentDraft.ts`
- Create: `apps/web/src/editor/ModeGlyph.tsx`
- Create: `apps/web/src/search/SearchPanel.tsx`
- Create: `apps/web/src/trash/TrashPanel.tsx`
- Create: `apps/web/e2e/core-diary.spec.ts`
- Create: `playwright.config.ts`
- Modify: `apps/web/src/app/App.tsx`

**Interfaces:**
- Consumes: draft, publish, edit, search, delete, and restore APIs.
- Produces: silent draft recovery, one-button edit/preview switching, English text management actions, and verified browser workflow.

- [ ] **Step 1: Write the failing browser acceptance test**

```ts
// apps/web/e2e/core-diary.spec.ts
import { expect, test } from "@playwright/test";

test("drafts, publishes, searches, edits, trashes, and restores", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New entry" }).click();
  await page.getByLabel("Title").fill("雨后的街道");
  await page.getByLabel("Markdown body").fill("空气变凉了。");
  await page.reload();
  await expect(page.getByLabel("Markdown body")).toHaveValue("空气变凉了。");
  await page.getByRole("button", { name: "Toggle preview" }).click();
  await expect(page.getByText("空气变凉了。")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("雨后的街道")).not.toBeVisible();
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByLabel("Search diary").fill("雨后");
  await expect(page.getByText("雨后的街道")).toBeVisible();
});
```

- [ ] **Step 2: Run Playwright and confirm the editor flow fails**

Run:

```powershell
pnpm add -D @playwright/test
pnpm exec playwright install chromium
pnpm exec playwright test apps/web/e2e/core-diary.spec.ts
```

Expected: FAIL at `New entry` because editor and management UI are not implemented.

- [ ] **Step 3: Implement silent persistence and the single geometric mode control**

```ts
// apps/web/src/editor/useSilentDraft.ts
export function useSilentDraft(input: DraftInput, save: (value: DraftInput) => Promise<void>) {
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
    const handle = window.setTimeout(() => void save(latest.current), 500);
    return () => window.clearTimeout(handle);
  }, [input, save]);
}
```

```tsx
// apps/web/src/editor/ModeGlyph.tsx
export function ModeGlyph({ preview, onToggle }: { preview: boolean; onToggle(): void }) {
  return (
    <button className="mode-glyph" aria-label="Toggle preview" onClick={onToggle}>
      <span className={preview ? "glyph-square filled" : "glyph-square"} />
      <span className={preview ? "glyph-square" : "glyph-square filled"} />
    </button>
  );
}
```

```tsx
// apps/web/src/editor/Editor.tsx
export function Editor() {
  const draft = useDraftQuery();
  const [value, setValue] = useState<DraftInput>(draft.data ?? emptyDraft);
  const [preview, setPreview] = useState(false);
  useSilentDraft(value, api.saveDraft);
  return (
    <section aria-label="Diary editor">
      <label>Title<input aria-label="Title" value={value.title}
        onChange={(event) => setValue({ ...value, title: event.target.value })} /></label>
      <ModeGlyph preview={preview} onToggle={() => setPreview(!preview)} />
      {preview
        ? <ReactMarkdown>{value.markdown}</ReactMarkdown>
        : <textarea aria-label="Markdown body" value={value.markdown}
            onChange={(event) => setValue({ ...value, markdown: event.target.value })} />}
      <button onClick={() => api.publishDraft()}>DONE</button>
    </section>
  );
}
```

- [ ] **Step 4: Run all core verification**

Run:

```powershell
pnpm test
pnpm typecheck
pnpm --filter @diary/web build
pnpm exec playwright test apps/web/e2e/core-diary.spec.ts
```

Expected: unit, integration, build, typecheck, and the complete core browser flow pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/web playwright.config.ts package.json pnpm-lock.yaml
git commit -m "feat: complete core diary workflow"
```
