# Local Diary Web — Design Specification

**Date:** 2026-07-26  
**Status:** Approved in conversation; awaiting written-spec review  
**Primary platform:** Windows PC  
**Primary timezone:** Asia/Shanghai

## 1. Product Goal

Build a private, local-first diary that works in a browser and in a standalone desktop window. A user can create multiple entries per day. Every published entry contains a required title and Markdown body, with optional inline images, one optional MP3, and optional tags.

The product prioritizes a quiet, durable reading experience. Media handling, backup, and export must still be reliable enough for long-term personal use. Version one is local-only but keeps stable identifiers and service boundaries so cross-device sync can be added later without replacing the local data model.

## 2. Scope

### Included in version one

- Browser access through a loopback-only local service.
- A standalone Windows desktop window using the same web interface.
- One local user with no account, login, application lock, or encryption.
- Multiple published entries per day.
- One active draft at a time.
- Markdown editing with edit/preview switching.
- Multiple inline images per entry.
- One MP3 per entry with metadata and cover recognition.
- Optional tags.
- Full-text and music-metadata search.
- Continuous chronological reading across days.
- Light and dark themes.
- Trash with recovery and timed permanent deletion.
- Automatic local backup, complete archive export, and Markdown export.
- Responsive behavior for narrow desktop windows and mobile browsers.

### Deferred

- Accounts and cloud-hosted access.
- Cross-device sync.
- Collaborative or multi-user diaries.
- Multiple simultaneous drafts.
- Entry time editing.
- Password protection and data encryption.
- Rich-text/WYSIWYG editing.
- Multiple songs or playlists on one entry.
- PDF export.
- Version history for entry edits.

## 3. System Architecture

### 3.1 Runtime shape

The product has three layers:

1. **Shared web client:** a responsive TypeScript web interface used by both browser and desktop modes.
2. **Local application service:** a loopback-only service bound to `127.0.0.1`. It owns persistence, search, media processing, backup, export, and external music-metadata calls.
3. **Desktop shell:** an Electron window that starts and stops the same local service and loads the shared web client.

Browser mode starts the local service through a desktop shortcut and opens its loopback URL in the default browser. Desktop mode starts the same service and displays it in a standalone window. The service must reject non-loopback network access in version one.

The web client must never access the database or user media paths directly. It communicates through a versioned local API. This API boundary becomes the future synchronization boundary.

### 3.2 Persistence

- **SQLite** stores entries, draft state, tags, media metadata, search indexes, trash state, and backup metadata.
- **Filesystem media storage** stores original images, display-sized image derivatives, thumbnails, original MP3 files, and manually selected cover images.
- Large media bytes are not stored inside SQLite.
- Entry and media records use stable, globally unique identifiers.
- Database and media paths are resolved relative to an application data root rather than hard-coded absolute paths.

### 3.3 Offline behavior

Writing, reading, editing, search, local playback, image viewing, backup, restore, and export work without internet access. Internet access is used only when embedded and filename-derived music information is insufficient and the user requests online recognition.

## 4. Domain Model

### 4.1 Entry

Each entry stores:

- Stable entry ID.
- Required title.
- Required Markdown body.
- State: `draft`, `published`, or `trashed`.
- Immutable `published_at` timestamp, created only when the user selects `DONE`.
- `created_at` and `updated_at` audit timestamps.
- Optional `deleted_at` timestamp.
- Zero or more tags.
- Ordered inline image references.
- Zero or one MP3 reference.

The title is used in search results and management indexes. It is never rendered as the first line of the reading body.

All product date grouping and visible entry times use `Asia/Shanghai`. A published entry time is displayed to minute precision and cannot be edited. Editing a published entry updates `updated_at` and causes an English `EDITED` marker to appear in indexes, not in the reading body.

### 4.2 Draft

- At most one draft exists.
- Selecting the new-entry action while a draft exists reopens that draft.
- Draft changes are persisted silently in the background for crash recovery.
- Background draft persistence does not publish, close, timestamp, or visually interrupt the editor.
- The entry becomes published only after its title and body pass validation and the user selects `DONE`.
- `published_at` is the current Beijing time at completion, not the draft start time or first-keystroke time.

### 4.3 Images

- An entry may contain any number of images.
- Images can be inserted at any Markdown cursor position.
- The original uploaded image is retained unchanged.
- The application generates a display-sized derivative and a thumbnail.
- Exports can include originals.
- Image loading is lazy in the continuous timeline.

### 4.4 Music

- An entry may contain at most one MP3.
- Its music card is always rendered after the Markdown body, including inline images.
- The original MP3 is retained unchanged and is never re-encoded by metadata editing.
- Stored metadata includes title, artist, album, year, cover source, recognition status, and user overrides.
- All metadata fields and cover art can be corrected manually.

Recognition order:

1. Read embedded ID3 text and cover art.
2. Normalize usable embedded values and filename text, then query an online metadata adapter for missing fields and cover candidates.
3. If textual matching is insufficient, generate an audio fingerprint and query a fingerprint adapter.
4. If several plausible matches remain, present candidates for explicit user selection.
5. If recognition fails or the network is unavailable, preserve the MP3, show its filename with a plain solid-color cover, and allow manual completion.

Provider-specific APIs are isolated behind adapters so a provider can be replaced without changing stored entry or music data.

### 4.5 Tags and search

- Tags are optional and reusable.
- Reading mode hides tags by default.
- On pointer-capable devices, tags and entry management actions appear when the pointer enters the entry edge.
- On touch devices, a focused entry exposes the same controls through an English text action.
- Search covers entry title, Markdown plain text, tags, song title, artist, and album.
- Search results may show titles; opening a result scrolls to the full entry in the chronological timeline.

## 5. Core User Flows

### 5.1 Create and publish

1. Select the custom geometric new-entry control.
2. If a draft exists, return to it; otherwise create one.
3. Enter a required title and required Markdown body.
4. Insert images at the current cursor position as needed.
5. Attach up to one MP3; recognition runs without blocking text editing.
6. Add optional tags.
7. Use a single unlabelled custom geometric control to alternate between Markdown editing and rendered preview.
8. Select the English `DONE` action.
9. Validate title and body, create the immutable Beijing publication time, and insert the entry into the continuous timeline.

### 5.2 Read and navigate

- Desktop layout uses an 88 px date scale on the left and a centered long-form reading page on the right.
- All entries are fully expanded and ordered newest-first within each day.
- Days continue vertically without separate page navigation.
- Selecting a date scrolls to its day.
- Scrolling updates the active date in the scale.
- The entry title is absent from the reading body.
- Narrow layouts replace the vertical rail with a horizontal date scale above the single-column reading page.

### 5.3 Edit and delete

- A published entry can be edited at any time.
- Its immutable publication time remains unchanged.
- Updated entries receive the index-only `EDITED` marker.
- Deleting moves an entry and its exclusive media references to trash.
- Trashed entries can be restored for 30 days.
- At service startup and once per day while it remains running, local cleanup permanently deletes entries that have spent 30 days in trash and removes media no longer referenced elsewhere.

### 5.4 Music playback

- Playback begins from the music card after the entry body.
- Playback continues while the user scrolls across entries and days.
- A minimal floating player appears only while audio is active.
- The player uses the same custom geometric system as other controls.
- Stopping playback removes the floating player after a short, non-bouncy fade.

## 6. Visual and Interaction System

### 6.1 Final layout direction

The selected direction is **Fine Scale**:

- 88 px vertical date rail.
- Centered long-form reading column.
- Large day numeral and restrained English date metadata.
- Entry time in the reading margin.
- Generous vertical separation without rounded entry cards.
- Continuous day breaks expressed with typography and hairline rules.

### 6.2 Color

The selected theme is **Warm Paper**:

- Light surface: warm ivory.
- Dark surface: warm ink-black.
- Primary text: warm near-black or warm off-white.
- Accent: restrained ochre used only for focus, active date, progress, and selected state.
- No gradients, glass effects, colored shadows, glow, or decorative texture.

The default follows the Windows theme. A manual override is available and remembered until the user returns to system-following mode.

### 6.3 Typography and language

- All interface copy is English.
- English interface text, dates, numbers, buttons, statuses, and navigation use the Windows system **Georgia** font, with a system serif fallback if Georgia is unavailable.
- Chinese may appear only in diary bodies, diary titles in indexes/search, and music-related metadata.
- All Chinese text uses the same packaged, redistributable Chinese serif family as the diary body.
- The application does not depend on remote font loading and does not redistribute Georgia.

### 6.4 Symbols

- Do not use a general-purpose icon library.
- Do not use sparkle, magic, heart, generic gear, decorative ellipsis, or rounded icon-button patterns associated with template-like interfaces.
- Use a small custom geometric set with consistent stroke width, dimensions, endpoints, spacing, hover states, and focus states.
- Reserve symbols for new entry, theme, edit/preview state, playback, and similarly high-frequency universal controls.
- Use concise English text for less frequent or potentially ambiguous actions.

### 6.5 Motion

- Motion is limited to short fades, small disclosure transitions, and theme interpolation.
- Do not use bounce, parallax, floating cards, exaggerated scaling, spring motion, or animation that draws attention away from reading.
- Respect the operating system reduced-motion setting by removing nonessential transitions.

## 7. Backup, Export, and Restore

### 7.1 Automatic backup

- Create one scheduled local backup per day when the application next runs.
- Retain the latest 30 logical snapshots.
- Snapshots are incremental and content-deduplicated so unchanged original images and MP3 files do not consume 30 physical copies.
- Every retained snapshot must be independently restorable through its manifest.
- The backup location is configurable; the application proposes a folder under the user's Documents directory on first run.

### 7.2 Complete archive

A one-action export creates a self-contained archive containing:

- SQLite data export or portable database snapshot.
- Original images.
- Image derivatives required for immediate restoration.
- Original MP3 files.
- Cover overrides.
- A versioned manifest with checksums.

### 7.3 Markdown export

- Export one entry or a selected Beijing date range.
- Produce readable Markdown files.
- Include referenced original images and MP3 files using portable relative paths.
- Preserve published timestamps, title, tags, and recognized music metadata in front matter even though the reading view hides titles.

### 7.4 Safe restore

1. Validate archive version, manifest, and checksums in a staging location.
2. If validation fails, stop without changing current data.
3. Create a safety backup of current data.
4. Restore data atomically.
5. Rebuild derived thumbnails and search indexes if their versions differ.

## 8. Error Handling

- Draft recovery must survive page refresh, renderer crash, service restart, and ordinary power loss within the guarantees of SQLite and atomic filesystem replacement.
- Music recognition failure never blocks attaching or playing a valid MP3.
- A corrupt image or MP3 displays a concise English text message while the rest of the entry and timeline remain usable.
- Failed derivative generation preserves the original and can be retried.
- Disk-full, permission, and backup-location errors are shown as persistent English text notices with a direct recovery action.
- Destructive actions require clear English confirmation when recovery will no longer be possible.
- Restore and permanent cleanup operations are logged locally.

## 9. Performance and Capacity

- Support at least 20,000 entries without changing the data model.
- Use indexed date, state, title, tag, and search fields.
- Virtualize or window the continuous timeline while preserving natural cross-day scrolling.
- Lazy-load image derivatives and music metadata views.
- Do not load MP3 bytes until playback or export requires them.
- Search and date jumps should feel immediate on the target PC after indexes are warm.
- Large exports and backup maintenance report unobtrusive textual progress and must not freeze writing.

## 10. Verification Strategy

### Unit tests

- Beijing timestamp creation and day grouping.
- Draft and publication state transitions.
- Markdown/media reference parsing.
- Tag normalization.
- Music metadata precedence and manual overrides.
- Trash retention and cleanup eligibility.
- Backup manifests, checksums, and deduplication decisions.

### Integration tests

- SQLite transactions with atomic media moves.
- Image original/derivative lifecycle.
- ID3 parsing, textual lookup adapter, fingerprint adapter, and offline fallback.
- Search indexing for titles, body text, tags, and music metadata.
- Complete archive creation and staged restore.
- Markdown export with portable relative media paths.

### End-to-end tests

- Create multiple entries on one Beijing day.
- Recover a silent background draft after forced interruption.
- Publish a cross-midnight draft and verify completion-time grouping.
- Insert multiple images at different Markdown positions.
- Attach one MP3, correct metadata, and continue playback across date scrolling.
- Edit a published entry without changing its publication time.
- Delete, restore, and permanently expire an entry.
- Search every supported field and jump to the result.
- Follow Windows theme, apply a manual override, and retain it.
- Use the desktop rail and narrow horizontal date scale.

### Visual verification

- Compare final light and dark screens against the approved Fine Scale direction.
- Check Georgia use in every English interface surface.
- Check that Chinese appears only in allowed content categories and always uses the body serif.
- Check spacing, hairlines, ochre use, and custom symbol consistency.
- Check reduced motion and keyboard focus without introducing generic icon-library visuals.

## 11. Acceptance Criteria

The first version is ready when:

1. A user can safely draft, publish, read, edit, search, delete, restore, back up, export, and restore diary data on a Windows PC.
2. Multiple entries per Beijing day appear as a fully expanded, continuous cross-day reading stream.
3. Required titles remain absent from reading bodies but are useful in search and management indexes.
4. Images retain originals and render efficiently inline.
5. One MP3 per entry is recognized through the defined fallback chain, remains manually correctable, and plays continuously while scrolling.
6. Automatic backups provide 30 restorable logical snapshots without duplicating unchanged media for each snapshot.
7. Browser and desktop modes use the same local data and interface.
8. The interface follows the approved language, typography, color, symbol, motion, and responsive rules.
9. Automated tests cover critical state, media, backup, restore, and timezone behavior.
10. Visual review confirms that reading quality remains the product's highest-priority experience.
