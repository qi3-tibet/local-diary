import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8");

describe("responsive anchor offsets", () => {
  it("uses one mobile document offset just beyond the fixed 58px date strip", () => {
    expect(appCss).toContain("scroll-padding-top: 64px;");
    expect(appCss).not.toContain("scroll-margin-top");
  });
});

describe("music metadata visual language", () => {
  it("shares the plain Georgia text-button treatment and reserves the body serif for music content", () => {
    expect(appCss).toMatch(/\.music-candidate button,\s*\.music-metadata-actions button,/);
    expect(appCss).toMatch(/\.music-candidate-copy\s*\{[^}]*font-family: var\(--body-cn-font\)/s);
    expect(appCss).toMatch(/\.music-metadata-editor\s*\{[^}]*font-family: var\(--ui-font\)/s);
  });
});

describe("desktop chrome regressions", () => {
  it("gives the desktop date rail enough room for the native date field", () => {
    expect(appCss).toContain("--date-rail-width: 156px;");
    expect(appCss).toContain("margin-left: var(--date-rail-width);");
    expect(appCss).toContain("width: var(--date-rail-width);");
  });

  it("draws the system theme indicator as one clipped circle", () => {
    expect(appCss).toMatch(
      /\.theme-control::before\s*\{[^}]*linear-gradient\(90deg,\s*currentColor 0 50%,\s*transparent 50% 100%\)/s,
    );
    expect(appCss).not.toContain(".theme-control::after");
  });

  it("does not use a bottom border for the fixed top menu hover state", () => {
    expect(appCss).toMatch(/\.workspace-tools button\s*\{[^}]*border:\s*0;/s);
    expect(appCss).not.toMatch(
      /\.workspace-tools button:hover,[^{]*\{[^}]*border-bottom-color/s,
    );
  });
});

describe("reading measure", () => {
  it("allows a maximum body line exactly three times wider than the previous 536px measure", () => {
    expect(appCss).toContain("--reading-page-width: 1682px;");
    expect(appCss).toContain(
      "width: min(var(--reading-page-width), calc(100vw - var(--date-rail-width) - 92px));",
    );
  });
});
