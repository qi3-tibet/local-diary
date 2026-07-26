import { describe, expect, it } from "vitest";
import {
  transformSelectionAfterReplacement,
  transformUploadAnchor,
  transformUploadAnchorAfterReplacement,
} from "./selection-anchor";

describe("transformUploadAnchor", () => {
  it("shifts an upload anchor when text is inserted before it", () => {
    expect(transformUploadAnchor(
      { start: 12, end: 12 },
      "Alpha target Omega",
      "Prefix Alpha target Omega",
    )).toEqual({ start: 19, end: 19 });
  });

  it("preserves replacement text and collapses an overlapping selection after it", () => {
    expect(transformUploadAnchor(
      { start: 7, end: 17 },
      "Before replace me after",
      "Before kept note after",
    )).toEqual({ start: 16, end: 16 });
  });

  it("tracks a deletion before and into the original selection", () => {
    expect(transformUploadAnchor(
      { start: 7, end: 17 },
      "Before replace me after",
      "Befme after",
    )).toEqual({ start: 5, end: 5 });
  });

  it("uses the actual input range when repeated characters make a diff ambiguous", () => {
    expect(transformUploadAnchorAfterReplacement(
      { start: 11, end: 11 },
      { start: 11, end: 11 },
      1,
    )).toEqual({ start: 12, end: 12 });
  });

  it("keeps exact-boundary typing after an original insertion anchor", () => {
    expect(transformUploadAnchorAfterReplacement(
      { start: 11, end: 11 },
      { start: 11, end: 11 },
      1,
      "left",
    )).toEqual({ start: 11, end: 11 });
  });
});

describe("transformSelectionAfterReplacement", () => {
  it("keeps a later user caret attached to the same text", () => {
    expect(transformSelectionAfterReplacement(
      { start: 24, end: 24 },
      { start: 6, end: 6 },
      10,
    )).toEqual({ start: 34, end: 34 });
  });

  it("does not move a user caret before the completed upload", () => {
    expect(transformSelectionAfterReplacement(
      { start: 2, end: 2 },
      { start: 6, end: 6 },
      10,
    )).toEqual({ start: 2, end: 2 });
  });
});
