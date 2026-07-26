# Entry-windowed Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep API responses, client memory, and mounted articles bounded while preserving natural bidirectional diary reading, date/search jumps, and scroll anchors for dense and sparse dates.

**Architecture:** Replace day-only keyset paging with signed entry keysets over `(published_at, id)`, returning at most 120 entries grouped into unique date groups with full-day counts. Merge pages by entry ID into a 480-entry client cache, then render a maximum 200-entry window whose boundaries can move within a single day without duplicating that day's section.

**Tech Stack:** TypeScript, React 19, TanStack Query, Fastify, better-sqlite3, Vitest/Testing Library, Playwright.

## Global Constraints

- Cursor payload is HMAC signed, versioned, direction-bound, and strictly validates both `publishedAt` and `id`.
- SQL ordering and cursor comparisons use both `published_at` and `id`, including entries sharing one millisecond.
- Every API page and date jump returns at most 120 entries.
- Client cache is capped at 480 entries and mounted `article.entry` nodes stay below 250, with a target of 200.
- Dense single-day and mixed-day traversal must be continuous in both directions with no duplicate or missing entry IDs.
- Trimming either cache end must retain a cursor capable of reloading it.
- Date headers use the full database day count; no duplicate day section or DOM ID is allowed.
- Existing date rail, search jump, day jump, image growth, and variable-body anchor behavior remain available.
- No “load more” button replaces continuous scrolling.

---

### Task 1: Entry keyset repository contract

**Files:**
- Modify: `apps/server/src/entries/repository.ts`
- Modify: `apps/server/test/performance.test.ts`

**Interfaces:**
- Produces: `DayPage.days: Array<{ day: string; totalEntries: number; entries: Entry[] }>`
- Produces: opaque v2 cursors with `{ publishedAt, id, direction, v: 2 }`
- Produces: `selectEntryWindow` and bounded `selectEntriesAroundDay` behavior through the existing route-facing repository methods.

- [x] Add RED tests seeding 20,000 entries on one day and asserting the centered page contains `1..120` entries, its day count is 20,000, and its serialized entry count never exceeds 120.
- [x] Add RED tests with more than 240 entries sharing one millisecond; traverse older, reverse newer, and assert exact ordered ID equality, no duplicates, no gaps, cursor tamper rejection, wrong-direction rejection, and malformed timestamp/ID rejection.
- [x] Run `pnpm vitest run apps/server/test/performance.test.ts` and record the expected unbounded-page/type failures.
- [x] Implement v2 encode/decode validation, tuple keyset SQL, bounded centered-day selection, and one grouped count query for returned dates.
- [x] Run the focused server tests until GREEN without weakening the assertions.

### Task 2: API and bounded client cache

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/app/App.tsx`
- Create: `apps/web/src/app/day-page-cache.ts`
- Create: `apps/web/src/app/day-page-cache.test.ts`

**Interfaces:**
- Consumes: bounded `DayPage` from Task 1.
- Produces: `mergeDayPages(current, incoming, direction, 480)` that merges same-day entries by ID, preserves total counts, sorts by `(publishedAt,id) DESC`, trims the opposite edge, and installs the incoming boundary cursor needed to reload trimmed content.

- [x] Add RED API-client tests for `totalEntries` and page cursor calls.
- [x] Add RED cache tests for overlapping same-day pages, exact ID order, unique groups, 480 cap, and reload cursor preservation after trimming both ends.
- [x] Run the focused tests and record their expected failures.
- [x] Implement the typed API response and pure cache merge helper, then replace `App.mergeDays`.
- [x] Run focused API/cache tests until GREEN.

### Task 3: Entry-level rendering window and anchors

**Files:**
- Modify: `apps/web/src/diary/WindowedTimeline.tsx`
- Modify: `apps/web/src/diary/WindowedTimeline.test.tsx`
- Modify: `apps/web/src/diary/DateRail.tsx`
- Modify: `apps/web/src/diary/date-groups.ts`

**Interfaces:**
- Consumes: day groups with `totalEntries` and at most 480 cached entries.
- Produces: one section per visible day, at most 200 mounted entries, entry-aware top/bottom window keys, measured entry-slice spacers, and stable pre-change entry/day anchors.

- [x] Add a RED dense-day unit test with 300 cached entries asserting `<250` mounted articles, one `day-*` section, and first/last visible entry IDs change continuously at both sentinels without duplicates.
- [x] Add a RED mixed-day unit test retaining the 15-day sparse window while enforcing the article bound.
- [x] Add RED ResizeObserver tests for body/image growth above a visible entry and the expected scroll correction.
- [x] Add a RED top loaded-edge prepend test: trigger `onNeedNewer`, prepend a real page, and assert a previously visible entry retains its viewport top.
- [x] Run the focused suite and record all expected failures.
- [x] Implement an entry-index window capped at 200, regroup only the visible slice into unique day sections, display `totalEntries`, measure omitted entry slices, and make both pending-load directions capture/restore the same entry anchor.
- [x] Run the focused suite until GREEN.

### Task 4: Unified programmatic navigation

**Files:**
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/e2e/performance.spec.ts`

**Interfaces:**
- Produces: one programmatic day-navigation path used by the rail, search results, and initial `?day=`, always setting the jump lock and navigation reset before replacing the page.

- [x] Add a RED direct-URL E2E that opens `/?fixture=large&day=2025-07-26`, verifies the target is visible and the cache is bounded, and records every day-page request to assert the locked jump issues no directional paging request.
- [x] Run that E2E and retain its first expected failure.
- [x] Remove the independent requested-day `scrollIntoView` effect and route initial query success through the same locked navigation state transition as rail/search jumps.
- [x] Run the direct-URL E2E until GREEN.

### Task 5: Dense and mixed traversal integration

**Files:**
- Modify: `apps/server/src/e2e-large-fixture.ts`
- Modify: `apps/server/src/e2e.ts`
- Modify: `apps/web/e2e/performance.spec.ts`

**Interfaces:**
- Produces: token-gated dense and mixed 20,000-entry E2E fixture modes.

- [x] Add RED E2E coverage for a single dense day and mixed dates, recording every newly entered entry ID during a 600-entry older → newer → older traversal that crosses the 480-entry cache boundary.
- [x] Assert each observed direction has exact expected tuple-ordered IDs, no gaps/duplicates, one section ID per day, `<250` articles, API response pages `<=120`, and cached entry count `<=480`; traverse all 20,000 IDs separately at repository level.
- [x] Add the smallest test-only fixture mode needed to seed density deterministically.
- [x] Run the focused E2E until all traversal and bound assertions are GREEN.

### Task 6: Full verification and report

**Files:**
- Modify: `.superpowers/sdd/desktop-task-3-report.md`

**Interfaces:**
- Consumes: all completed tasks.
- Produces: fresh verification evidence and final commits.

- [x] Run focused repository, cache, timeline, API, and E2E tests three times.
- [x] Run `pnpm typecheck`, `pnpm test`, and `pnpm exec playwright test`.
- [x] Run `pnpm --filter @diary/web build`.
- [x] Run `pnpm --filter @diary/desktop exec electron-builder --win`.
- [x] Run `pnpm test:e2e:cleanup`, inspect only exact project-owned temporary roots, and run `git diff --check`.
- [x] Update the report with root causes, cursor/cache/window contracts, RED evidence, and exact fresh results.
- [x] Commit all implementation and report changes and provide both SHA values.
