import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8");
const tokensCss = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");
const fontLicense = fileURLToPath(new URL("../../public/licenses/JetBrainsMono-NerdFont.txt", import.meta.url));

function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return appCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "su"))?.[1] ?? "";
}

describe("offline language typography", () => {
  it("packages only the Noto Serif SC weights used by diary content", () => {
    expect(tokensCss).toContain(
      '@import "@fontsource/noto-serif-sc/chinese-simplified-400.css";',
    );
    expect(tokensCss).toContain(
      '@import "@fontsource/noto-serif-sc/chinese-simplified-600.css";',
    );
    expect(tokensCss).not.toContain('@import "@fontsource/noto-serif-sc/400.css";');
    expect(tokensCss).not.toContain('@import "@fontsource/noto-serif-sc/600.css";');
    expect(tokensCss).not.toMatch(/@fontsource\/noto-serif-sc\/(?:100|200|300|500|700|800|900)\.css/u);
  });

  it("uses Georgia for Latin content while preserving the Chinese body fallback", () => {
    expect(tokensCss).toContain("--body-content-font: Georgia, \"Noto Serif SC\"");
    expect(ruleFor(".entry-body")).toContain("font-family: var(--body-content-font)");
    expect(ruleFor(".entry-title-index")).toContain("font-family: var(--body-content-font)");
    expect(ruleFor(".music-metadata")).toContain("font-family: var(--body-content-font)");
    expect(ruleFor(".date-rail")).toContain("font-family: var(--ui-font)");
    expect(ruleFor(".management-action")).toContain("font-family: var(--ui-font)");
  });

  it("packages the terminal font and gives inline code a distinct code treatment", () => {
    expect(tokensCss).toContain("font-family: \"JetBrainsMono Nerd Font Mono\"");
    expect(tokensCss).toContain("JetBrainsMonoNerdFontMono-Regular.ttf");
    expect(tokensCss).toContain("JetBrainsMonoNerdFontMono-SemiBold.ttf");
    expect(ruleFor(".entry-body :not(pre) > code")).toContain("font-family: var(--code-font)");
    expect(ruleFor(".entry-code-block")).toContain("font-family: var(--code-font)");
  });

  it("copies the terminal-font license into the distributable public assets", () => {
    expect(existsSync(fontLicense)).toBe(true);
    expect(readFileSync(fontLicense, "utf8")).toContain("MIT License");
  });

  it("keeps the code copy control visible and large enough to tap", () => {
    const copy = ruleFor(".entry-code-copy");
    expect(copy).toContain("min-height: 40px");
    expect(copy).toContain("opacity: 1");
  });

  it("keeps interface controls and placeholders in Georgia", () => {
    expect(ruleFor("body")).toContain("font-family: var(--ui-font)");
    expect(ruleFor("button")).toContain("font-family: var(--ui-font)");
    expect(ruleFor(".management-heading input")).toContain(
      "font-family: var(--ui-font)",
    );
    expect(ruleFor("input::placeholder")).toContain("font-family: var(--ui-font)");
    expect(ruleFor("textarea::placeholder")).toContain("font-family: var(--ui-font)");
  });
});
