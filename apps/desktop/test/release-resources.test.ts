import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releaseArtifactNames } from "../scripts/release-checksums.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = path.join(desktopRoot, "assets");

describe("pinned release resources", () => {
  it("checksums only distributable release artifacts", () => {
    expect(releaseArtifactNames([
      "builder-debug.yml",
      "checksums.sha256",
      "Local-Diary-Setup-0.1.0-x64.exe",
      "Local-Diary-Setup-0.1.0-x64.exe.blockmap",
      "smoke-report.json",
    ])).toEqual([
      "Local-Diary-Setup-0.1.0-x64.exe",
      "Local-Diary-Setup-0.1.0-x64.exe.blockmap",
    ]);
  });

  it("verifies the bundled fpcalc executable against its manifest and version output", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(assetsRoot, "binaries.json"), "utf8"),
    ) as {
      fpcalc: {
        version: string;
        platform: string;
        architecture: string;
        sourceUrl: string;
        archiveSha256: string;
        sha256: string;
        versionOutput: string;
      };
    };
    const executable = path.join(assetsRoot, "fpcalc.exe");
    const checksum = createHash("sha256").update(readFileSync(executable)).digest("hex");
    const version = execFileSync(executable, ["-version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    }).trim();

    expect(manifest.fpcalc).toMatchObject({
      version: "1.6.0",
      platform: "windows",
      architecture: "x86_64",
      sourceUrl:
        "https://github.com/acoustid/chromaprint/releases/download/v1.6.0/chromaprint-fpcalc-1.6.0-windows-x86_64.zip",
      archiveSha256: "30179d3d0dc4cc92f1a0995c1a2e523fb4867724c2ee6a6ceae474f8e4d6937a",
    });
    expect(checksum).toBe(manifest.fpcalc.sha256);
    expect(version).toBe(manifest.fpcalc.versionOutput);
    expect(version).toMatch(/^fpcalc version 1\.6\.0(?:\s|$)/);
  });

  it("ships a deterministic vector source and a multi-size Windows icon", () => {
    const source = readFileSync(path.join(assetsRoot, "app-icon.svg"), "utf8");
    const icon = readFileSync(path.join(assetsRoot, "app.ico"));

    expect(source).toContain('viewBox="0 0 256 256"');
    expect(source).toContain('id="fine-scale-mark"');
    expect(source).not.toMatch(/(?:filter|gradient|data:image|<text)/i);
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    const count = icon.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, index) => {
      const width = icon[6 + index * 16];
      return width === 0 ? 256 : width;
    });
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });
});
