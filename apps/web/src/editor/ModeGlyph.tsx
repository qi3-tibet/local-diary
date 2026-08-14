import { MaterialSymbol } from "../icons/MaterialSymbol";

export function ModeGlyph({
  preview,
  onToggle,
}: {
  preview: boolean;
  onToggle(): void;
}) {
  return (
    <button
      className="mode-glyph"
      type="button"
      aria-label="Toggle preview"
      aria-pressed={preview}
      onClick={onToggle}
    >
      <MaterialSymbol name="visibility" />
    </button>
  );
}
