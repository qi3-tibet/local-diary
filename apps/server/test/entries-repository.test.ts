import { describe, expect, it } from "vitest";
import { createTestDatabase } from "@diary/test-support";
import { EntryRepository } from "../src/entries/repository.js";

describe("EntryRepository", () => {
  it("persists exactly one draft", () => {
    const db = createTestDatabase();
    const repository = new EntryRepository(db);
    repository.saveDraft({ title: "雨后的街道", markdown: "空气变凉了。", tags: ["散步"] });
    repository.saveDraft({ title: "更新后的标题", markdown: "仍然在想。", tags: [] });
    expect(repository.getDraft()).toMatchObject({
      title: "更新后的标题",
      state: "draft",
    });
    expect(repository.countByState("draft")).toBe(1);
  });
});
