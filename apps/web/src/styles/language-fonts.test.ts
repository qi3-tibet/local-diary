import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8");
const tokensCss = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

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

  it("assigns Chinese serif only to approved user-content surfaces", () => {
    expect(ruleFor(".entry-body")).toContain("font-family: var(--body-cn-font)");
    expect(ruleFor(".entry-title-index")).toContain("font-family: var(--body-cn-font)");
    expect(ruleFor(".music-metadata")).toContain("font-family: var(--body-cn-font)");
    expect(ruleFor(".date-rail")).toContain("font-family: var(--ui-font)");
    expect(ruleFor(".management-action")).toContain("font-family: var(--ui-font)");
  });

  it("keeps interface controls and placeholders in Georgia", () => {
    expect(ruleFor("body")).toContain("font-family: var(--ui-font)");
    expect(ruleFor("button")).toContain("font-family: var(--ui-font)");
    expect(ruleFor("input::placeholder")).toContain("font-family: var(--ui-font)");
    expect(ruleFor("textarea::placeholder")).toContain("font-family: var(--ui-font)");
  });
});
