# Desktop Task 4 report

Implementation base: `dc705dd`.

## Delivered

- Added deterministic Windows x64 NSIS packaging in `apps/desktop/electron-builder.yml`.
- Added ordinary desktop-window shortcuts plus direct Desktop and Start Menu browser-mode shortcuts whose argument is exactly `--browser`.
- Added a project-specific, vector-native Fine Scale application mark. `app-icon.svg` is the source; `generate-icon.mjs` deterministically produces a seven-image Windows ICO at 16, 24, 32, 48, 64, 128, and 256 px.
- Pinned the official AcoustID Chromaprint `fpcalc` Windows x86_64 1.6.0 helper. The upstream archive SHA-256 is `30179d3d0dc4cc92f1a0995c1a2e523fb4867724c2ee6a6ceae474f8e4d6937a`; the verified executable SHA-256 is `b5545bdf655b50e368a1844a4c13baf444e405ea5d5662396ff0292eaf9bf9e9`.
- Added source and packaged binary verification that checks presence, SHA-256, and the exact executable version output.
- Hardened cross-mode single-instance handling. A browser shortcut launched while desktop mode owns the service opens the existing URL; a desktop shortcut launched while browser mode owns the service creates a window without starting a second service.
- Set the packaged Electron product name explicitly to `Local Diary`, making the clean-install root `%APPDATA%\Local Diary`. Existing pre-release data under `%APPDATA%\@diary\desktop` is reused only when the current root has no `data` directory.
- Changed the first-install desktop backup proposal to `%USERPROFILE%\Documents\Local Diary Backups`. Existing configured paths remain authoritative. The release-smoke-only `DIARY_BACKUP_ROOT` override is absolute-path-only and is restored after the child process exits.
- Added stable Windows light/dark Fine Scale snapshots based on routed, deterministic fixture data and packaged offline fonts. Both baselines were reviewed visually.
- Added browser release-flow coverage, unpacked application smoke automation, real NSIS install/shortcut/uninstall automation, checksum generation, and the Windows release guide.

## TDD and debugging evidence

Initial release tests failed for the intended missing behaviors:

- no pinned binary manifest or `fpcalc.exe`;
- no SVG/ICO resources;
- no NSIS config or custom browser shortcuts;
- cross-mode second launches ignored the second process's arguments;
- no visual baselines;
- no Windows release documentation.

The implementation used red/green cycles for each resource, shortcut, cross-mode, backup-root, documentation, and checksum-filter behavior.

Systematic release-smoke debugging found and fixed:

1. PowerShell's bodyless POST supplied an unsupported media type to Fastify. The smoke now sends an explicit JSON body to the publish route.
2. A hidden desktop process has no discoverable `MainWindowHandle`, so it could not prove clean window shutdown. The smoke shows the desktop window for the WM_CLOSE path while keeping browser-only helpers hidden.
3. The first checksum script included `builder-debug.yml` and a previous smoke report. A tested pure artifact filter now includes only the installer and blockmap.
4. Full-suite order left a 2040 dense fixture ahead of the newly published 2026 release-flow entry. The release-flow test now navigates to the published response's Beijing day instead of assuming the entry belongs in the latest 120-row page.

Read-only release review then identified three Important issues, each reproduced with a failing regression before repair:

1. The Electron package metadata did not pin `productName`, so a pre-release run had created `%APPDATA%\@diary\desktop` despite the release guide promising `%APPDATA%\Local Diary`. The package now pins `Local Diary`, and startup deterministically prefers current data while retaining a non-destructive legacy fallback.
2. A cached destroyed browser-owned window prevented a later desktop shortcut from creating a replacement. Destroyed windows are now rejected before focus/reuse.
3. The installer retention smoke probed an arbitrary temporary directory rather than the real default user-data root. It now refuses to touch a pre-existing `%APPDATA%\Local Diary`, creates a uniquely owned marker there, proves silent uninstall preserves it, and safely removes only its owned root afterward.
4. Re-review found that the cleanup initially trusted only an earlier ownership flag and exact root path, leaving a race in which newly created user data could be removed. Cleanup now rereads the unique token and requires the root to contain exactly the single ownership marker; any changed root is preserved with a warning.

An independent final review found four further Important release-verification gaps plus one documentation clarification, all addressed with regressions:

1. Electron's explicit `--user-data-dir` could still fall back to the real pre-release root when its new temporary `data` directory did not exist. Both argument forms now disable legacy fallback, and the unpacked smoke refuses an existing root and proves its own `data\diary.sqlite` exists. The real legacy database hash and timestamp remained unchanged across the final smoke.
2. Binary verification and its resource test executed `fpcalc.exe` before comparing its checksum. Manifest trust shape, byte size, and SHA-256 are now validated before an injectable runner can execute; a tampered candidate regression proves the runner is never called.
3. Failure cleanup deleted any shortcut at the four candidate paths. It now reparses each remaining shortcut and deletes only an exact target-and-arguments match for the smoke installation, preserving anything changed or not provably owned.
4. The installer smoke checked existence for all four shortcuts but parsed only three. It now parses and reports all four, requiring empty ordinary arguments and exactly `--browser` for both browser shortcuts.
5. The release guide now distinguishes desktop-owned shutdown from a secondary desktop window opened by a browser-owned process.
6. Internal re-review found that failure cleanup still invoked the NSIS uninstaller before manual shortcut ownership checks, allowing the uninstaller itself to delete a replaced link. Failure cleanup now runs the uninstaller only after the install root is known to be smoke-owned and every existing shortcut reparses as an exact target-and-arguments match; otherwise it preserves the installation and warns, while manual cleanup removes only provably owned links.
7. Independent re-review found the normal success path still relied on its earlier shortcut parse before invoking NSIS. The success path now repeats the complete install-root and four-link ownership preflight immediately before normal uninstall; any changed or unparseable link aborts uninstall and is preserved.

## Final artifacts

Generated artifacts are intentionally ignored by git and remain under `apps/desktop/release/`.

- Installer: `apps/desktop/release/Local-Diary-Setup-0.1.0-x64.exe`
  - SHA-256: `d863c2dbcde35e34e5c563fb833feeb508a2bb7b57efe6632d3d4f7624e60779`
- Blockmap: `apps/desktop/release/Local-Diary-Setup-0.1.0-x64.exe.blockmap`
  - SHA-256: `011ab1e41908ee0c303453219af89406a7538054d692184f8312514acb7cc326`
- Unpacked app: `apps/desktop/release/win-unpacked/Local Diary.exe`
- Checksum file: `apps/desktop/release/checksums.sha256`

`Get-AuthenticodeSignature` returned `NotSigned` for both the installer and unpacked executable. This is documented as an unsigned local test build; no signing claim is made.

## Fresh verification

- Focused desktop release suites: 3 files, 18 tests passed in three consecutive runs.
- Focused visual and release-flow Playwright suite: 3/3 passed in three consecutive runs.
- Full unit/integration suite: 41 files, 245 tests passed.
- Workspace typecheck: all five projects passed.
- Recursive production build: all five projects passed; web built 248 modules.
- Performance-to-release order regression: 7/7 Playwright tests passed.
- Full Playwright suite: 29/29 passed.
- Binary verification: source and packaged copies matched the pinned checksum and reported `fpcalc version 1.6.0 (FFmpeg Lavc62.11.100 Lavf62.3.100 SwR6.1.100)`.
- Packaged metadata verification: extracting `package.json` from the final `app.asar` showed `productName: "Local Diary"`.
- NSIS packaging: completed for Windows x64.
- Unpacked smoke:
  - exactly one `127.0.0.1` listener;
  - zero non-loopback listeners;
  - one service through desktop/browser handoff;
  - clean desktop shutdown released the port;
  - a second desktop launch and browser mode reused the same data directory;
  - the isolated temporary `data\diary.sqlite` existed and the real pre-release database remained byte-for-byte and timestamp unchanged.
- Silent installer smoke:
  - all four actual `.lnk` files existed;
  - ordinary shortcut arguments were empty;
  - both browser shortcuts used exactly `--browser`;
  - silent uninstall removed the shortcuts;
  - the external data-retention probe remained;
  - the uniquely owned `%APPDATA%\Local Diary` probe remained through uninstall and was then safely cleaned.
- `pnpm test:e2e:cleanup`: smoke passed and found no project-owned temporary roots or loopback listeners.
- Temporary release-smoke, installer, retention, diagnostic, and download roots were removed after their absolute paths were checked under the OS temporary directory.
- No Local Diary process or created Desktop/Start Menu shortcut remained.
- `git diff --check`: passed.

## Non-blocking warnings

Electron Builder reported pnpm duplicate dependency references and listed non-Windows Sharp optional packages that were intentionally absent. The required Windows native `.node` modules were present in `app.asar.unpacked`, image handling was covered by the full suite, and the unpacked application smoke passed. Electron Builder also logged signtool steps, but Windows signature inspection remained `NotSigned`; the release guide explicitly treats the signature API result as authoritative.

## Review

The same read-only release reviewer rechecked every original, independent, and follow-up finding after the final ownership-order repair. Final verdict: **Ready — Yes**, with no remaining Critical or Important findings.
