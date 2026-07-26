export type TextRange = {
  start: number;
  end: number;
};

export function transformUploadAnchor(
  anchor: TextRange,
  before: string,
  after: string,
): TextRange {
  if (before === after) return anchor;

  let changeStart = 0;
  while (
    changeStart < before.length
    && changeStart < after.length
    && before[changeStart] === after[changeStart]
  ) {
    changeStart += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < before.length - changeStart
    && suffixLength < after.length - changeStart
    && before[before.length - 1 - suffixLength] === after[after.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const replacedEnd = before.length - suffixLength;
  const replacementEnd = after.length - suffixLength;
  if (replacedEnd <= anchor.start) {
    const delta = replacementEnd - replacedEnd;
    return { start: anchor.start + delta, end: anchor.end + delta };
  }
  if (changeStart >= anchor.end) return anchor;

  const stableTailLength = Math.min(suffixLength, before.length - anchor.end);
  const anchoredReplacementEnd = after.length - stableTailLength;
  return { start: anchoredReplacementEnd, end: anchoredReplacementEnd };
}

export function transformUploadAnchorAfterReplacement(
  anchor: TextRange,
  replaced: TextRange,
  replacementLength: number,
  affinity: "left" | "right" = "right",
): TextRange {
  if (
    replaced.start === replaced.end
    && replaced.start === anchor.start
    && anchor.start === anchor.end
    && affinity === "left"
  ) {
    return anchor;
  }
  if (replaced.end <= anchor.start) {
    const delta = replacementLength - (replaced.end - replaced.start);
    return { start: anchor.start + delta, end: anchor.end + delta };
  }
  if (replaced.start >= anchor.end) return anchor;

  const replacementEnd = replaced.start + replacementLength;
  return { start: replacementEnd, end: replacementEnd };
}

export function transformSelectionAfterReplacement(
  selection: TextRange,
  replaced: TextRange,
  replacementLength: number,
): TextRange {
  if (selection.start === selection.end) {
    const cursor = transformPoint(selection.start, replaced, replacementLength, "left");
    return { start: cursor, end: cursor };
  }
  return {
    start: transformPoint(selection.start, replaced, replacementLength, "left"),
    end: transformPoint(selection.end, replaced, replacementLength, "right"),
  };
}

function transformPoint(
  point: number,
  replaced: TextRange,
  replacementLength: number,
  gravity: "left" | "right",
): number {
  if (point < replaced.start) return point;
  if (point > replaced.end) {
    return point + replacementLength - (replaced.end - replaced.start);
  }
  if (point === replaced.end && replaced.end > replaced.start) {
    return replaced.start + replacementLength;
  }
  return gravity === "right" ? replaced.start + replacementLength : replaced.start;
}
