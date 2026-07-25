# Core Task 5 Report

## Status

Complete. The web package now provides the approved Fine Scale reading shell, Warm Paper themes, typed published-entry loading, and responsive date navigation.

## Delivered

- Added a React/Vite web workspace consuming `GET /api/v1/entries` as the shared `Entry[]` contract; no response adapter was required.
- Added Beijing-day grouping, newest-first ordering, English date metadata, entry-margin times, Markdown body rendering, and explicit omission of entry titles.
- Added the fixed 88 px desktop date rail with scroll-aware active dates and anchor navigation.
- Added the under-720 px horizontal date strip and single-column reading layout.
- Added persisted `system | light | dark` theme state that follows live Windows preference while in system mode.
- Added the restrained Warm Paper tokens, Georgia UI typography, Chinese serif fallback, hairline structure, focus states, and reduced-motion behavior.
- Kept the shell free of icon libraries, gradients, glass, glow, shadows, spring motion, media UI, and editor UI.

## TDD Evidence

The inherited implementation record states that the initial focused runs failed because
`Timeline`, `DateRail`, `theme-store`, `ThemeControl`, and the API client did not exist.
This takeover could independently verify the completed GREEN state, but could not replay
that original pre-implementation RED state without discarding the finished work.

The takeover self-review found one additional lifecycle case and completed a fresh
RED/GREEN cycle:

- RED: replacing one rendered day with another left `IntersectionObserver` attached to
  the detached section because the effect depended only on `groups.length`; the focused
  test failed with 0 observer cleanups instead of 1.
- GREEN: the effect now depends on the rendered day keys, so it disconnects and observes
  the replacement sections even when the number of days is unchanged.

The final focused run passed:

```text
4 test files passed
11 tests passed
```

Covered behavior includes full cross-day bodies, reading-title omission, Beijing
grouping/order, English empty state, active and replacement date sections, theme
persistence/system following/cycling, and direct API contract consumption/error handling.

## Verification

- `pnpm vitest run apps/web/src/diary/Timeline.test.tsx apps/web/src/theme/theme-store.test.ts apps/web/src/theme/ThemeControl.test.tsx apps/web/src/api/client.test.ts` — pass, 4 files and 11/11 tests.
- `pnpm --filter @diary/web build` — pass; 231 modules transformed.
- `pnpm typecheck` — pass across contracts, test support, server, and web.
- `pnpm test` — pass before the final observer-only patch, 9 files and 21/21 tests;
  the affected focused tests were rerun after the patch.
- The previous implementer recorded browser visual QA at 1440×1000 in light and dark
  themes and 390×844 in dark theme using mocked shared-contract `Entry[]` data. The
  takeover did not repeat that browser-only check.

## Self-review

- Confirmed entry titles never enter the timeline DOM.
- Confirmed the API response is already `Entry[]`; no adapter or backend change is present.
- Confirmed the desktop rail is exactly 88 px and switches to a 58 px horizontal strip below 720 px.
- Confirmed all interface copy is English and uses the UI font token; Chinese body content uses the serif fallback token.
- Confirmed prohibited visual/media/editor patterns are absent.
- Confirmed changing the rendered day keys rebinds the active-day observer even when the
  group count is unchanged.
- Stopped the inherited Vite preview server on port 4173 and confirmed build output
  remains ignored rather than entering the source diff.

## Concerns

None blocking. The current shared contract provides TypeScript typing but no runtime `Entry[]` schema, so the web client intentionally performs no shape adaptation or runtime transformation.

## Reviewer Follow-up — 2026-07-26

All three Core Task 5 review findings were addressed:

- Added a synchronous inline head bootstrap that resolves remembered `light | dark` or
  the current system preference and applies both `data-theme` and `color-scheme` before
  the React module loads. The Zustand store remains the runtime source of truth and
  continues to synchronize later preference changes.
- Expanded the timeline observer coverage to capture and invoke the real observer
  callback. The test drives simultaneous visible records and an entry/exit transition,
  asserting that the nearest intersecting day is reported.
- Replaced the cumulative mobile `82px` document plus `80px` section offsets with one
  `64px` document scroll-padding offset for the fixed `58px` horizontal date strip.
  Section scroll margins were removed.

Fresh RED evidence:

```text
3 affected test files
3 failed, 9 passed
```

The two dark first-paint cases failed because the bootstrap script was missing. The
responsive CSS case failed because `scroll-padding-top: 64px` was absent and section
scroll margins were still present. The new callback-driven observer test passed against
the existing selection algorithm.

Fresh GREEN verification after the fixes:

- `pnpm vitest run apps/web/src/theme/theme-store.test.ts apps/web/src/diary/Timeline.test.tsx apps/web/src/styles/app.test.ts` — pass, 3 files and 12/12 tests.
- `pnpm --filter @diary/web build` — pass with Vite 8.1.5; 231 modules transformed.
- `pnpm typecheck` — pass across contracts, test support, server, and web.
