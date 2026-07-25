# Local Diary Delivery Roadmap

The approved product specification is implemented through four independent plans. Each plan ends with a runnable, reviewable product increment and must be completed in order.

1. **Core diary:** local web service, SQLite, one-draft workflow, Markdown text entries, tags, search, trash, Fine Scale timeline, themes, and responsive navigation.
2. **Images and music:** inline originals plus derivatives, one MP3 per entry, ID3 and online recognition adapters, manual correction, streaming, and persistent player.
3. **Backup and portability:** deduplicated daily snapshots, complete archive export and safe restore, Markdown export, and backup settings.
4. **Desktop and release:** Electron shell, browser launcher, packaged fonts, accessibility, performance validation, final visual regression, and Windows packaging.

Plans:

- `docs/superpowers/plans/2026-07-26-local-diary-core.md`
- `docs/superpowers/plans/2026-07-26-local-diary-media.md`
- `docs/superpowers/plans/2026-07-26-local-diary-backup.md`
- `docs/superpowers/plans/2026-07-26-local-diary-desktop-release.md`

The source of truth for behavior and acceptance criteria remains:

- `docs/superpowers/specs/2026-07-26-local-diary-web-design.md`

## Specification Traceability

| Specification area | Implementation owner |
|---|---|
| Runtime architecture, loopback API, SQLite | Core Tasks 1–2 |
| One draft, completion timestamp, multiple daily entries | Core Tasks 2–3 |
| Editing, tags, search, trash, timed cleanup | Core Task 4 |
| Fine Scale timeline, language, theme, responsive layout | Core Tasks 5–6; Desktop Task 2 |
| Inline originals and image derivatives | Media Tasks 1–2 |
| One MP3, metadata recognition, manual correction | Media Tasks 3–4 |
| Continuous playback and corrupt-media isolation | Media Task 5 |
| Deduplicated daily snapshots and 30-snapshot retention | Backup Task 1 |
| Complete archive, validation, safety backup, restore | Backup Task 2 |
| Portable Markdown and original media export | Backup Task 3 |
| Backup settings, permission errors, progress | Backup Task 4 |
| Electron desktop and browser shortcuts | Desktop Task 1 |
| Georgia, packaged Chinese serif, reduced motion, accessibility | Desktop Task 2 |
| 20,000-entry performance | Desktop Task 3 |
| Windows installer and final visual/release gate | Desktop Task 4 |
