import { describe, expect, it } from "vitest";
import { createBeijingClock } from "../src/time/beijing.js";

describe("BeijingClock", () => {
  it("rounds publication time to the minute and groups in Asia/Shanghai", () => {
    const clock = createBeijingClock(() => new Date("2026-07-26T16:03:49.999Z"));
    expect(clock.publishedAt()).toBe("2026-07-27T00:03:00+08:00");
    expect(clock.dayKey("2026-07-27T00:03:00+08:00")).toBe("2026-07-27");
  });
});
