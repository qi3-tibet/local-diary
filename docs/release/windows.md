# Local Diary Windows local-test release

Local Diary 0.1.0 is an **unsigned local test build** for Windows x64. It is not code-signed and Windows may show a SmartScreen warning. The release is intended for local testing on the PC that owns the diary; it does not expose the service beyond `127.0.0.1`.

## Build from source

Use Windows PowerShell from the repository root with Node.js 24 and pnpm 11.9.0:

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm -r build
pnpm exec playwright test
node apps/desktop/scripts/verify-binaries.mjs
pnpm release:win
```

`pnpm release:win` regenerates the icon from its committed SVG, builds all workspaces, creates the x64 NSIS installer, and writes `apps/desktop/release/checksums.sha256`. Generated release files remain outside git.

## Artifacts and checksums

The verified release directory is `apps/desktop/release/`.

| Artifact | SHA-256 |
|---|---|
| `Local-Diary-Setup-0.1.0-x64.exe` | `0e244eaf0523490a4cd7be0b8d29ae5dd30232ad4f1e7d63ca3f71ffdabe456b` |
| `Local-Diary-Setup-0.1.0-x64.exe.blockmap` | `0842fdea1d85aaa006a6768851842dac19dd2f90ec757fc7ff8597a71c30589c` |

Verify an artifact independently:

```powershell
Get-FileHash -Algorithm SHA256 apps/desktop/release/Local-Diary-Setup-0.1.0-x64.exe
Get-AuthenticodeSignature apps/desktop/release/Local-Diary-Setup-0.1.0-x64.exe
```

`Get-AuthenticodeSignature` returned `NotSigned` for both the installer and unpacked executable. Electron Builder's “signing with signtool.exe” log line does not prove Authenticode signing; the Windows signature API result above is authoritative.

The bundled helper is the official Chromaprint `fpcalc` 1.6.0 Windows x86_64 release. Its source archive SHA-256 is `30179d3d0dc4cc92f1a0995c1a2e523fb4867724c2ee6a6ceae474f8e4d6937a`; the bundled `fpcalc.exe` SHA-256 is `b5545bdf655b50e368a1844a4c13baf444e405ea5d5662396ff0292eaf9bf9e9`. The exact source URL and version output are committed in `apps/desktop/assets/binaries.json`. Verify the source and packaged copies with:

```powershell
node apps/desktop/scripts/verify-binaries.mjs --packaged apps/desktop/release/win-unpacked/resources/fpcalc/fpcalc.exe
```

## Install and launch

Run `Local-Diary-Setup-0.1.0-x64.exe`, choose a per-user install location, and complete setup. The installer creates four shortcuts:

- `Local Diary` on the Desktop and Start Menu opens the standalone desktop window.
- `Local Diary - Browser` on the Desktop and Start Menu launches the same application with `--browser`, starts the same loopback-only service, and opens its URL in the default browser.

Launching either shortcut while Local Diary is already running hands off to the existing process. It does not start a second service or a second data owner. Closing the standalone window performs a clean service shutdown. Closing only a browser tab does not stop browser mode; end `Local Diary` from Task Manager when browser-only use is finished.

## Local data and backups

The default Windows paths are:

- Diary database, media, settings, logs, and temporary work: `%APPDATA%\Local Diary` (primary data under `%APPDATA%\Local Diary\data`).
- Proposed first-run backup location: `%USERPROFILE%\Documents\Local Diary Backups`.

Pre-release builds used `%APPDATA%\@diary\desktop`. To avoid stranding an existing local diary, Local Diary reuses that legacy root only when `%APPDATA%\Local Diary\data` does not exist and the legacy `data` directory does. If both exist, the current `%APPDATA%\Local Diary` root wins. This is path compatibility, not a destructive migration.

The backup location can be changed in `SETTINGS`. If a previous installation already stored a custom backup path, Local Diary keeps that configured path rather than silently moving existing backups.

The installer and uninstaller do not place diary data inside the installation directory. **Uninstall preserves diary data and backups by default.** Uninstall removes application files and all four shortcuts, but it does not delete `%APPDATA%\Local Diary`, `%USERPROFILE%\Documents\Local Diary Backups`, or a custom backup directory. Delete those folders manually only after verifying a complete archive if permanent removal is intended.

## Clean-machine smoke checklist

On a Windows x64 test account with no existing Local Diary shortcuts:

1. Verify the installer SHA-256 and confirm Authenticode status is `NotSigned`.
2. Disconnect the network, install, and open `Local Diary`.
3. Confirm the Fine Scale timeline loads in a standalone window and create an entry with Chinese text.
4. Close the window; confirm no `Local Diary` process or listening port remains.
5. Reopen the desktop shortcut and confirm the entry remains.
6. Open `Local Diary - Browser`; confirm the same entry appears in the default browser at a `http://127.0.0.1:<port>` URL.
7. Run `Get-NetTCPConnection -State Listen` and confirm Local Diary owns only a `127.0.0.1` listener, never `0.0.0.0`, a LAN address, or `[::]`.
8. Attach a valid MP3 and confirm local playback; online recognition may remain unavailable while disconnected.
9. Choose a backup location, create a snapshot, export a complete archive, and verify the downloaded file.
10. Uninstall. Confirm all four shortcuts disappear and the diary plus backup folders remain.
11. Reinstall and confirm the preserved entry is reused.

Automated equivalents used by the release gate:

```powershell
apps/desktop/scripts/smoke-release.ps1 `
  -AppPath apps/desktop/release/win-unpacked/Local Diary.exe `
  -UserDataRoot $env:TEMP\LocalDiaryReleaseSmoke `
  -ReportPath apps/desktop/release/smoke-report.json

apps/desktop/scripts/smoke-installer.ps1 `
  -InstallerPath apps/desktop/release/Local-Diary-Setup-0.1.0-x64.exe `
  -InstallRoot $env:TEMP\LocalDiaryInstallSmoke `
  -RetentionProbeRoot $env:TEMP\LocalDiaryRetentionSmoke
```

The unpacked smoke covers first launch, desktop mode, browser mode, one service instance, clean desktop shutdown, same-directory data reuse, and absence of non-loopback listeners. The installer smoke parses the actual `.lnk` targets and arguments, silently uninstalls, and verifies that both an external retention probe and a uniquely owned marker under the real `%APPDATA%\Local Diary` root survive uninstall. For safety it refuses to run if that default user-data root already exists, and it removes only the root it created after the assertion.
