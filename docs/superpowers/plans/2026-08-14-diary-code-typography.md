# Diary Code Typography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render mixed-language diary content with Georgia Latin glyphs and add packaged JetBrains Mono Nerd Font code blocks with VS Code syntax highlighting.

**Architecture:** Keep Markdown parsing in `DiaryMarkdown`; introduce a focused `CodeBlock` renderer that normalises the fence language, highlights known languages with Shiki, and owns copy feedback. CSS variables define typography and code colours for each application theme.

**Tech Stack:** React 19, react-markdown, Shiki, Vite, Vitest, CSS custom properties.

## Global Constraints

- Package JetBrainsMono Nerd Font Mono regular and semibold locally under `apps/web/src/assets/fonts` with its MIT licence.
- Use `light-plus` and `dark-plus` Shiki themes.
- Preserve Chinese Noto Serif SC packaging and leave the Markdown textarea in the body font.
- Unknown fence languages render plain code without an error.

---

### Task 1: Add local typography assets and mixed-content CSS

**Files:**
- Create: `apps/web/src/assets/fonts/JetBrainsMonoNerdFontMono-Regular.ttf`
- Create: `apps/web/src/assets/fonts/JetBrainsMonoNerdFontMono-SemiBold.ttf`
- Create: `apps/web/src/assets/fonts/LICENSE-JetBrainsMono-NerdFont.txt`
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/src/styles/app.css`
- Test: `apps/web/src/styles/language-fonts.test.ts`

- [x] Write CSS assertions for the content font stack, local `@font-face` declarations, and inline-code monospace styling.
- [x] Copy the installed regular and semibold terminal-font files, preserving the upstream licence.
- [x] Define `--body-content-font`, `--code-font`, and light/dark code tokens; use the content stack on the approved diary-content surfaces.
- [x] Style inline code and fenced-code containers using the local font and accessible theme colours.
- [x] Run `pnpm --filter @diary/web test -- language-fonts.test.ts`.

### Task 2: Add safe code-block rendering

**Files:**
- Create: `apps/web/src/diary/CodeBlock.tsx`
- Create: `apps/web/src/diary/CodeBlock.test.tsx`
- Modify: `apps/web/src/diary/EntryBody.tsx`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

- [x] Add red tests for supported-language highlighting, unsupported-language fallback, language labels, and Clipboard API copying.
- [x] Add Shiki and implement a focused renderer for fenced Markdown code; normalise aliases and escape unknown values by rendering text only.
- [x] Register the renderer through `react-markdown` while preserving current image and hard-line-break behavior.
- [x] Run `pnpm --filter @diary/web test -- CodeBlock.test.tsx EntryBody.test.tsx`.

### Task 3: Verify the integrated reader

**Files:**
- Modify: `apps/web/src/diary/EntryBody.test.tsx`
- Modify: `apps/web/src/styles/app.test.ts`

- [x] Add coverage showing inline code remains separate from fenced code and theme-specific class hooks exist.
- [x] Run web unit tests, typecheck, and production build.
- [x] Inspect the built asset list to confirm packaged font files are emitted.
