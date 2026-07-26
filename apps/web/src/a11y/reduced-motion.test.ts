import { describe, expect, it } from "vitest";
import { prefersReducedMotion } from "./reduced-motion";

describe("prefersReducedMotion", () => {
  it("reads the operating-system reduced-motion preference", () => {
    const matchMedia = (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
    });

    expect(prefersReducedMotion(matchMedia)).toBe(true);
  });

  it("is safe when media queries are unavailable", () => {
    expect(prefersReducedMotion(undefined)).toBe(false);
  });
});
