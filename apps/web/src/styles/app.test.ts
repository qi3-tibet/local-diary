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
