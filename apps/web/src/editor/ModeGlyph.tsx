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
      <span
        aria-hidden="true"
        className={preview ? "glyph-square filled" : "glyph-square"}
      />
      <span
        aria-hidden="true"
        className={preview ? "glyph-square" : "glyph-square filled"}
      />
    </button>
  );
}
