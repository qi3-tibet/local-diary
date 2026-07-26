# Final integration hardening report

Branch: `codex/local-diary`

Starting HEAD: `08b2861`

## Outcome

All seven whole-branch review findings were implemented with isolated RED→GREEN
regressions. The local diary now rejects hostile loopback requests, makes
autosave failures recoverable and visible, accepts real Beijing cursor
timestamps, validates and stage-migrates restore databases, performs safe
scheduled trash/media cleanup, exposes a sandboxed desktop directory chooser,
and accepts the full supported archive capacity without buffering an archive in
memory.

## Finding resolution

1. **Loopback request security**
   - Added a Fastify request guard for every `/api/v1/**` route.
   - The guard validates the canonical loopback Host against the socket's actual
     listening port and rejects foreign Origin and unsafe `Sec-Fetch-Site`
     contexts.
   - The Vite development proxy rewrites Origin only when it exactly matches
     the incoming local Vite Host. Hostile Origin values are preserved and
     rejected by the server.
   - RED evidence: an actual listening service returned `200` for attacker Host
     and cross-site Origin requests.
   - GREEN evidence: canonical `127.0.0.1`/`localhost` and originless local
     clients succeed; DNS rebinding, wrong port, foreign Origin, cross-site
     reads, and hostile draft mutations return `403` without changing data.

2. **Autosave failure and cancel safety**
   - `useSilentDraft` exposes `failed`, `retrying`, `recovered`, and explicit
     recovery-dismissal states without unhandled background rejections.
   - The editor keeps an accessible failure warning visible, offers retry, and
     requires explicit dismissal after recovery.
   - Cancel waits for pending media and flushes the latest changed draft before
     leaving; a failed flush leaves the editor open.
   - Unchanged initial values and untouched empty editors no longer create
     recovery drafts. Unchanged existing drafts and published-entry edits are
     not overwritten on cancel.
   - RED evidence: hook state was absent, a rejected background save was
     unhandled, and an untouched editor wrote an empty draft after 500 ms.
   - GREEN evidence: hook unit tests pass; failed-autosave E2E passed three
     consecutive runs; the empty-editor no-write/reload regression passes.

3. **Real Beijing cursor format**
   - Cursor validation accepts canonical immutable publication timestamps with
     or without fractional seconds.
   - A real `createBeijingClock` fixture publishes 241 same-minute entries and
     traverses older and newer pages in exact database order without gaps or
     duplicates.
   - RED evidence: the second real-clock page failed with
     `Invalid entry cursor`.

4. **Restore schema safety**
   - The current schema is version 11.
   - Restore preflight rejects future versions, invalid/incomplete current
     schemas, failed quick checks, foreign-key failures, and missing required
     tables, columns, or indexes before the live barrier.
   - It validates the exact normalized canonical FTS and index DDL, object
     ownership, an executable FTS `MATCH` probe, and the required cascading or
     restrictive foreign keys. SQL comments cannot spoof these checks.
   - Supported older candidates are migrated and fully validated only inside
     the owned staging directory before swap.
   - Future and incomplete candidates preserve the exact live SQLite bytes and
     never acquire the mutation barrier.

5. **Trash scheduler and media garbage collection**
   - Expired trash rows and their object references are captured transactionally
     in a durable cleanup queue.
   - Object removal uses content-addressed locks and rechecks every live, draft,
     trashed, and attachment reference before deletion.
   - Removal failures remain queued for retry; log failures never change the
     cleanup result.
   - Cleanup runs immediately on startup and at the next Beijing midnight.
   - Scheduler stop waits for an in-flight cleanup, including rejection, and
     restore waits for that stop before closing/swapping the database. Cleanup
     restarts only after services reopen.

6. **Desktop backup directory bridge**
   - The BrowserWindow uses `contextIsolation: true`, `sandbox: true`,
     `nodeIntegration: false`, and an absolute packaged preload path.
   - A CommonJS sandbox preload imports only Electron and exposes one frozen
     `chooseBackupDirectory()` method over one IPC channel.
   - Main-process selection canonicalizes a real absolute directory, rejects a
     filesystem root or non-directory, and removes its handler during shutdown.
   - Browser mode creates no bridge. The final `app.asar` contains
     `dist/preload.cjs`, contains no project `dist/preload.js`, and the extracted
     preload has no filesystem import.

7. **Archive capacity alignment**
   - Restore multipart transport accepts the 20 GiB content limit plus a bounded
     512 MiB transport allowance.
   - Upload and ZIP extraction remain streamed.
   - The exact configured boundary reaches archive validation; one byte over is
     rejected with `ARCHIVE_SIZE_LIMIT`.

## Additional integration defects found

- Restore could race a newly added trash cleanup. The scheduler now has an
  awaitable stop and is integrated with the restore barrier.
- The release smoke script failed for a `--user-data-dir` containing spaces
  because `Start-Process` joined an unquoted argument. The exact failed run
  created `C:\Users\qi3\Documents\New\data\diary.sqlite`; the argument is now
  quoted and a matching regression passes. The mistakenly created directory
  was moved to the Recycle Bin.
- Reopening an already recovered draft through the keyboard left focus on the
  `NEW ENTRY` button. The action now focuses the title field.
- Initial pristine editor state was autosaved after 500 ms and polluted later
  flows with an empty recovery draft. Silent save now begins only after a value
  change, and untouched cancel performs no write.

## Verification

- Focused hardening suites: 9 files, 59 tests, three consecutive passes
  (`14.30 s`, `13.68 s`, `14.66 s`).
- Autosave failure E2E: three consecutive `1/1` passes.
- Cross-test pollution sequence: three consecutive `9/9` passes.
- `pnpm test`: 44 files, 268 tests passed.
- `pnpm typecheck`: all workspace projects passed.
- `pnpm -r build`: all workspace projects passed.
- Full Playwright: 32/32 tests passed.
- `pnpm test:e2e:cleanup`: passed; no temporary roots or loopback listeners.
- Binary verification: `fpcalc` is present, checksum-matched, and reports
  version 1.6.0.
- `pnpm release:win`: Windows x64 NSIS package completed.
- Final unpacked smoke: isolated data path verified, exactly one loopback
  service, cross-mode single-instance handoff, clean shutdown, data reuse, and
  zero non-loopback listeners.
- Final installer smoke: all four shortcuts had the exact target/arguments;
  silent uninstall removed shortcuts and preserved both external and default
  user-data probes.
- Authenticode status remains honestly documented as `NotSigned`.

## Final artifacts

- Installer:
  `apps/desktop/release/Local-Diary-Setup-0.1.0-x64.exe`
  - SHA-256:
    `3051d78f64cca586fea2d38a84f21cf78868ff5bec18daaf280f281864567d3d`
- Blockmap:
  `apps/desktop/release/Local-Diary-Setup-0.1.0-x64.exe.blockmap`
  - SHA-256:
    `41429db0ec66a556ee0f0be996165cb59200692d1a4240fa216be16f64df1980`

Generated artifacts remain ignored under `apps/desktop/release/`.

## Review

The read-only final review found two Important issues:

- the Vite proxy could launder a hostile Origin;
- restore validation accepted a same-column non-FTS table and initially used
  comment-spoofable substring checks for index DDL.

Both received RED regressions, were fixed as described above, and passed three
consecutive focused runs. The same reviewer completed a read-only re-review and
reported no remaining Critical or Important findings.
