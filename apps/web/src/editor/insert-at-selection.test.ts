import { describe, expect, it } from "vitest";
import { insertAtSelection } from "./insert-at-selection";

describe("insertAtSelection", () => {
  it("inserts uploaded image Markdown at the active selection", () => {
    expect(insertAtSelection("before after", 7, 7, "![rain](media:image-1)"))
      .toEqual({
        value: "before ![rain](media:image-1)after",
        cursor: 29,
      });
  });

  it("replaces selected text and leaves the cursor after the image", () => {
    expect(insertAtSelection("before old after", 7, 10, "![new](media:image-2)"))
      .toEqual({
        value: "before ![new](media:image-2) after",
        cursor: 28,
      });
  });
});
