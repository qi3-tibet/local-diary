# Desktop Task 3 report

Implementation commits: `236195b`, `c2f4a00`, `d2b3022`, `fb1fe53`, `4474eab`, `27f9963`, `1c32cb5`, `7d74a68`, plus the current review-hardening commit.

## Delivered

The server exposes indexed, cursor-based published-entry pages at `/api/v1/entries/days`. Version-2 cursors are opaque base64url values signed with HMAC and contain the direction plus the exact `(published_at, id)` boundary. Validation rejects tampering, a wrong version or direction, invalid timestamps, and invalid UUIDs. Entry order is deterministic `published_at DESC, id DESC`, including same-millisecond entries. Each response contains at most 120 entries while every day group reports its full `totalEntries`; date and exact-entry centered queries are bounded by the same limit. Migration 010 adds the matching partial published-entry index.

The deterministic 20,000-entry fixture is transaction-backed and exists only on the test E2E server. It requires both `NODE_ENV=test` and the per-run `DIARY_E2E_TOKEN`; there is no production seed route.

The client keeps whole response segments so every retained boundary cursor remains reloadable, merges entries by ID, and trims at segment boundaries to about 480 cached entries. The timeline renders at most 200 entries and 15 day sections, so one 20,000-entry day remains bounded just like a sparse diary. Date jumps load a centered day page, while search results load a page centered on the selected published entry ID. A bounded entry-ID boundary trail makes forward/reverse traversal replay exact non-aligned windows after prepend and cache trim without gaps or duplicates.

`WindowedTimeline` now uses:

- one passive scroll listener, coalesced through `requestAnimationFrame`, to read the two adjacent sentinel geometries;
- a per-side armed-until-leave boundary state, preventing the same physical boundary encounter from cascading through multiple shifts or page requests;
- pending loaded-edge transitions, so a page that arrives while its sentinel remains near the viewport is consumed exactly once;
- normalized `windowStart` writes, including clamped last-window shifts;
- an explicit `navigationResetKey`, rather than treating ordinary active-day observer updates as external jumps;
- measured omitted-day spacers and pre-resize section positions, allowing ResizeObserver changes above the viewport to restore the previous visible anchor;
- an entry-ID visible-boundary trail (up to 80 boundaries), allowing exact reversal even when a 120-entry page is prepended into a non-aligned 200-entry window;
- a programmatic compensation guard that holds root scroll behavior at `auto` until the next animation frame observes the expected scroll, preventing smooth-scroll races and preventing compensation events from driving pagination;
- IntersectionObserver only for active-day tracking, with observer and pending animation-frame cleanup on unmount.

App-level date jumps temporarily disable timeline paging. Rail, search, and direct `?day=` navigation use the same reset-and-lock path. The jump retries once per animation frame until its section is actually mounted, then keeps instant scroll behavior and the paging lock until both scrollY and target geometry are stable for four frames. Cleanup naturally cancels retries on unmount or a superseding navigation.

## Review hardening

The review found three remaining production-scale defects:

1. Day-keyset paging could return an unbounded single day. Paging now operates on the strict entry tuple `(published_at, id)`, with a hard 120-entry API limit, exact same-millisecond traversal, full day counts, a roughly 480-entry segment cache, and a 200-entry DOM window.
2. A prepended 120-entry page changed window phase, so repeated half-window shifts could never return to an original non-aligned boundary. The entry-ID boundary trail records visible first/last IDs, replays retained boundaries before computing a new shift, and survives cache trim as long as the corresponding cursor segment is retained.
3. A real newer-page prepend calculated the correct anchor delta but root `scroll-behavior: smooth` made `window.scrollBy` asynchronous. The compensation transaction now holds inline `auto` until a later frame observes the applied delta (or a clamped position settles), synchronizes the scroll baseline, and suppresses boundary handling during the transaction.

The first rail jump also had a mount race: if its section did not exist in the first scheduled frame, the effect returned permanently. It now retries for the lifetime of `jumpTarget`; a focused test reproduces first-frame absence and later mount.

A final independent review found seven additional boundary concerns, all addressed:

1. Date-rail anchors now keep their real fragment `href` but route clicks through `onJumpDay`, so cached-but-unmounted days cannot bypass the fetch/reset/lock path.
2. Search selection now calls the strict published-entry `entryId` query rather than only the containing day. The repository centers a bounded page on that exact UUID and rejects malformed, missing, draft, or trashed targets. The locked navigation target is the entry element itself, so a later day-section scroll cannot override final visibility or focus.
3. A requested day with no entries resolves deterministically to the nearest returned day (newer on an equal-distance tie). A truly empty response ends the lock and renders an empty timeline rather than retrying a section that cannot mount.
4. Programmatic navigation increments a generation, invalidates any in-flight edge request, and synchronously locks paging before its own request starts. Late older/newer responses cannot merge into the new navigation, and no request can start afterward against the old cache lineage; fault-injection runs confirmed both regressions fail without their guards and pass when restored.
5. Initial-query errors are rendered before the opening-state branch, preventing an endless `OPENING` screen after a failed request.
6. Dense E2E traversal now crosses the 480-entry cache boundary with 600 unique same-millisecond entries, asserts strict `(publishedAt,id)` order, and reverses to the exact original entry. Repository coverage separately traverses and compares all 20,000 IDs. Direct-URL coverage records request directions and asserts none occur during the locked jump.
7. Timeline measurement maps are pruned to the current ordered-entry set, so repeated cache turnover cannot retain stale height or position keys indefinitely.

## Root cause and debugging evidence

Five earlier sentinel fixes (`d2b3022` through `1c32cb5`) improved individual symptoms but did not make traversal deterministic. The original IntersectionObserver design recreated observers whenever the loaded page or window changed while sharing armed state across those generations. When the bottom loaded-edge sentinel stayed intersecting, the replacement observer inherited `bottom=false`; the newly loaded page therefore never shifted into view.

Replacing the boundary observer alone exposed three related state-machine defects:

1. A clamped shift changed the boundary key even though the user had not left the boundary, permitting a same-side follow-up event to request another page.
2. External jumps stored an unnormalized raw `windowStart`; the next `-7` update could change only that raw value while leaving the rendered window unchanged.
3. Inferring external navigation from `activeDay` was invalid because IntersectionObserver also changes `activeDay`.

The final unexpected `direction=newer` requests were traced to exact scroll geometry: a 2020 jump touched the bottom boundary, its asynchronous anchor correction moved to the top boundary, and the subsequent 2025 jump touched the top again. `jumpTarget` had been cleared in the same animation frame as `scrollIntoView`, so paging was already enabled when the scroll-listener frame ran. Holding the jump lock until scrolling settles removed both requests.

For resize preservation, capturing an anchor inside the ResizeObserver callback was too late: layout had already changed. The timeline now records section positions before the change and restores from that prior measurement.

## Test coverage added

The focused timeline suite contains 12 cases covering sparse and dense bounds, sentinel/spacer DOM order, three forward shifts and exact reversal, non-aligned boundary replay twice after prepend/cache trim, stale active-day props, loaded edges that stay near the viewport, cascade prevention after a clamped shift, explicit navigation rearming, cleanup, pre-change ResizeObserver anchors, and smooth-root compensation without an accidental page request. Cache tests verify whole-segment trimming and reloadable cursors. Nine App navigation tests cover direct-URL lock/reset, delayed mounting, exact-entry final focus, immediate request-time paging lock, both day/search request-failure unlock paths, stale paging-response rejection, nearest-day empty-date semantics, and initial-query errors.

The browser performance suite now:

- waits for actual scroll/window settling instead of fixed sleeps;
- travels older until it exceeds 60 calendar days;
- verifies each newly entered section is in the viewport and contains an entry;
- reverses to the exact original window;
- asserts unique mounted day IDs and fewer than 250 entry articles;
- verifies that a preceding mounted entry growing to 900 px preserves the visible-day anchor within 8 px.
- gates a real `direction=newer` response so the request-time visible entry can be measured, then verifies the prepend preserves it within 8 px;
- streams 600 entries from a 20,000-entry, single-day, same-millisecond fixture older, newer, and older again, matching API IDs exactly across the cache boundary while cache stays at or below 480 and DOM stays below 250;
- verifies direct `?day=` navigation uses the locked path, starts with exactly 120 cached entries, and issues no directional paging request during the jump.
- opens the newest edge entry from dense-day search and verifies that the selected article remains both in the viewport and focused after locked navigation settles.

## Fresh verification after review hardening

- Server performance suite: 7/7 passed in three consecutive fresh runs, including full ordered traversal of all 20,000 fixture IDs and exact-entry centering.
- Focused navigation/API/cache/timeline/server suites: 47/47 passed in three consecutive fresh runs, then the final 49/49 passed after adding both navigation-failure unlock cases.
- Browser performance E2E: all 6 scenarios passed in three consecutive fresh runs (33.9 s, 34.0 s, 33.6 s).
- Workspace typecheck: all five projects passed in three consecutive fresh runs and once more after the final error-path change.
- Full unit/integration suite: 38 files, 227 tests passed.
- Full Playwright suite: 26/26 passed.
- Web production build passed with 248 modules transformed.
- Windows x64 Electron packaging completed successfully at `apps/desktop/release/win-unpacked`.
- `pnpm test:e2e:cleanup` passed its smoke test and verified no project-owned temporary roots or loopback listeners. A separate exact-name inspection found no `local-diary-playwright-*` directory under the OS temporary root.
- No navigation, trail, or anchor diagnostic markers remain. `git diff --check` passes.
