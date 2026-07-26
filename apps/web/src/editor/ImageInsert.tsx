import { type ChangeEvent, useRef, useState } from "react";

type ImageInsertProps = {
  onSelect(image: File): Promise<void>;
};

export function ImageInsert({ onSelect }: ImageInsertProps) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(false);

  async function selectImage(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const image = event.target.files?.[0];
    if (!image) return;
    setUploading(true);
    setError(false);
    try {
      await onSelect(image);
    } catch {
      setError(true);
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  return (
    <div className="image-insert">
      <input
        ref={input}
        className="image-input"
        type="file"
        accept="image/avif,image/gif,image/jpeg,image/png,image/tiff,image/webp"
        tabIndex={-1}
        onChange={(event) => void selectImage(event)}
      />
      <button
        className="image-glyph"
        type="button"
        aria-label="Insert image"
        disabled={uploading}
        onClick={() => input.current?.click()}
      >
        <span className="image-glyph-frame" aria-hidden="true">
          <span className="image-glyph-mark" />
        </span>
      </button>
      {error ? <span className="image-insert-error" role="alert">IMAGE UPLOAD FAILED</span> : null}
    </div>
  );
}
