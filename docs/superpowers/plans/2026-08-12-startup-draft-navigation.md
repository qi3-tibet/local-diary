# Startup Draft Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve an existing diary draft without automatically opening its editor when the application starts.

**Architecture:** `App` continues to query the one persisted draft so the editor can use it after the user chooses `NEW ENTRY`. Removing the draft-recovery view transition leaves the diary timeline as the stable landing view without changing persistence or editor behavior.

**Tech Stack:** React 19, TanStack Query, Vitest, Testing Library, TypeScript.

## Global Constraints

- Startup with or without a draft must show the diary timeline.
- `NEW ENTRY` remains the explicit action that opens the editor and receives the existing draft.
- Do not change SQLite draft persistence, cancellation, or publication behavior.

---

### Task 1: Keep the diary view on startup when a draft exists

**Files:**
- Modify: `apps/web/src/app/App.navigation.test.tsx`
- Modify: `apps/web/src/app/App.tsx:38,171-175`

**Interfaces:**
- Consumes: `api.getDraft(): Promise<Entry | null>` through the existing `draftRecoveryQuery`.
- Produces: the existing initial `View` value, `"diary"`, until the user triggers navigation.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/app/App.navigation.test.tsx`, expose the existing mocked `getDraft` function, make it resolve to a draft-shaped `Entry`, and add this test within the existing `describe` block:

```tsx
it("keeps the timeline open when a saved draft exists at startup", async () => {
  window.history.replaceState({}, "", "/");
  getDraft.mockResolvedValue({ ...targetEntry, state: "draft", publishedAt: null });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

  await screen.findByTestId("timeline");
  await waitFor(() => expect(getDraft).toHaveBeenCalled());
  expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @diary/web test -- src/app/App.navigation.test.tsx`

Expected: FAIL because the current startup draft-recovery effect calls `setView("editor")` after `getDraft` resolves with a draft.

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/app/App.tsx`, remove the `checkedDraftRecovery` ref and the effect that switches to the editor:

```tsx
useEffect(() => {
  if (!draftRecoveryQuery.isSuccess || checkedDraftRecovery.current) return;
  checkedDraftRecovery.current = true;
  if (draftRecoveryQuery.data) setView("editor");
}, [draftRecoveryQuery.data, draftRecoveryQuery.isSuccess]);
```

Also remove the three remaining assignments to `checkedDraftRecovery.current`; they only guarded the deleted auto-navigation behavior. Leave `draftRecoveryQuery` intact because `Editor` reads the cached draft when the user selects `NEW ENTRY`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @diary/web test -- src/app/App.navigation.test.tsx`

Expected: PASS; the timeline renders after the mocked draft query resolves and the editor does not render automatically.

- [ ] **Step 5: Verify related project checks**

Run: `pnpm --filter @diary/web typecheck && pnpm --filter @diary/web test -- src/app/App.navigation.test.tsx apps/web/src/editor/useSilentDraft.test.tsx`

Expected: PASS; TypeScript accepts the updated App and draft autosave behavior remains green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/App.tsx apps/web/src/app/App.navigation.test.tsx docs/superpowers/plans/2026-08-12-startup-draft-navigation.md
git commit -m "fix: keep diary home open when draft exists"
```
