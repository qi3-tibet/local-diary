# Diary Code Typography Design

## Goal

Make English letters and Arabic numerals in diary content render in Georgia while Chinese content remains Noto Serif SC, and render Markdown code with the user's terminal font and VS Code-style syntax colours.

## Typography

- User-content surfaces (`.entry-body`, the entry title input/index, and music metadata) use `Georgia, "Noto Serif SC", "Songti SC", SimSun, serif`.
- The browser selects Georgia for Latin letters and Arabic numerals, while CJK glyphs fall through to packaged Noto Serif SC.
- Package `JetBrainsMono Nerd Font Mono` regular and semibold weights locally. Its CSS family is `JetBrainsMono Nerd Font Mono`, with `Consolas` and `monospace` as fallbacks.
- The Markdown source textarea remains a diary-writing surface and does not change to monospace.

## Markdown code experience

- Fenced blocks use Shiki serverless highlighting with the VS Code `light-plus` theme in light mode and `dark-plus` in dark mode.
- A fence language such as `ts`, `typescript`, `js`, `javascript`, `css`, `json`, `html`, `bash`, `shell`, `python`, `sql`, `md`, or `markdown` selects its grammar. An absent or unsupported language renders as readable, uncoloured plain code.
- Highlighted fences display a normalised uppercase language label and a hover/focus-visible copy button. The copy operation writes the original text to the clipboard, briefly changes its accessible label to `Copied`, and fails silently when the Clipboard API is unavailable.
- Fenced blocks have no line numbers. They retain whitespace, scroll horizontally when necessary, and expose their source text as ordinary selectable text.
- Inline code uses the packaged monospace font with a subtle themed background, border, and no syntax colours.

## Accessibility and resilience

- Copy remains keyboard accessible and announces its state through the button label.
- Code colours use the VS Code theme foreground/background values and code surfaces follow the application theme.
- All rendering remains synchronous from the reader's perspective. Shiki grammar failure, unknown language, or a missing Clipboard API cannot stop diary rendering.

## Verification

- Unit tests prove language normalisation and fallback, highlighted code structure, safe copy behavior, and theme class selection.
- CSS tests prove the mixed content font stack, local font faces, code font use, and inline-code styling.
- The web typecheck, unit suite, and production build pass.
