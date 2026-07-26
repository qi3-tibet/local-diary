import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Windows release configuration", () => {
  it("pins deterministic NSIS names, resources, and shortcut behavior", () => {
    const config = readFileSync(path.join(desktopRoot, "electron-builder.yml"), "utf8");
    const installer = readFileSync(path.join(desktopRoot, "build", "installer.nsh"), "utf8");
    const packageMetadata = JSON.parse(
      readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
    ) as { productName?: string };

    expect(packageMetadata.productName).toBe("Local Diary");
    expect(config).toMatch(/^appId: com\.localdiary\.app$/m);
    expect(config).toMatch(/^productName: Local Diary$/m);
    expect(config).toContain("artifactName: Local-Diary-Setup-${version}-${arch}.${ext}");
    expect(config).toContain("target: nsis");
    expect(config).toContain("icon: assets/app.ico");
    expect(config).toContain("to: fpcalc/fpcalc.exe");
    expect(config).toContain("createDesktopShortcut: true");
    expect(config).toContain("createStartMenuShortcut: true");
    expect(config).toContain("include: build/installer.nsh");

    expect(installer).toMatch(/CreateShortCut[\s\S]+--browser/);
    expect(installer).toContain("Local Diary - Browser.lnk");
    expect(installer).toContain('$SMPROGRAMS\\Local Diary - Browser.lnk');
    expect(installer).not.toContain("CreateDirectory");
    expect(installer).toMatch(/!macro customUnInstall[\s\S]+Delete[\s\S]+Local Diary - Browser\.lnk/);
    expect(installer).not.toMatch(/(?:RMDir|Delete).*(?:APPDATA|LOCALAPPDATA|userData|data|backups)/i);
  });

  it("keeps generated release artifacts out of source control", () => {
    const ignore = readFileSync(path.resolve(desktopRoot, "../../.gitignore"), "utf8");
    expect(ignore).toContain("apps/desktop/release/");
    expect(ignore).toContain("apps/web/e2e/*-snapshots/");
    expect(ignore).toContain("!apps/web/e2e/visual.spec.ts-snapshots/");
  });

  it("documents an honest reproducible local-test Windows release", () => {
    const guide = readFileSync(path.resolve(desktopRoot, "../../docs/release/windows.md"), "utf8");
    expect(guide).toContain("pnpm release:win");
    expect(guide).toContain("Local-Diary-Setup-0.1.0-x64.exe");
    expect(guide).toMatch(/SHA-256[\s\S]*[0-9a-f]{64}/i);
    expect(guide).toContain("unsigned local test build");
    expect(guide).toContain("%APPDATA%\\Local Diary");
    expect(guide).toContain("%USERPROFILE%\\Documents\\Local Diary Backups");
    expect(guide).toContain("--browser");
    expect(guide).toMatch(/uninstall[\s\S]*preserv/i);
    expect(guide).toContain("Get-AuthenticodeSignature");
    expect(guide).toContain("apps/desktop/scripts/smoke-release.ps1");
    expect(guide).toContain("apps/desktop/scripts/smoke-installer.ps1");
  });

  it("protects existing default user data while testing real uninstall retention", () => {
    const smoke = readFileSync(path.join(desktopRoot, "scripts", "smoke-installer.ps1"), "utf8");
    expect(smoke).toContain('Join-Path $env:APPDATA "Local Diary"');
    expect(smoke).toContain("will not touch existing Local Diary user data");
    expect(smoke).toContain("uninstallPreservedDefaultUserData");
    expect(smoke).toContain("$defaultRootOwnedAtCleanup");
    expect(smoke).toContain("[System.IO.File]::ReadAllText($defaultProbe)");
    expect(smoke).toContain("Get-ChildItem -LiteralPath $defaultUserData -Force");
    expect(smoke).toContain("$defaultChildren.Count -eq 1");
    expect(smoke).toContain("preserving it instead of deleting");
  });
});
