import { type ChangeEvent, useRef, useState } from "react";
import { MaterialSymbol } from "../icons/MaterialSymbol";

type ImageInsertProps = {
  disabled?: boolean;
  onSelect(image: File): Promise<void>;
};

export function ImageInsert({ disabled = false, onSelect }: ImageInsertProps) {
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
        hidden
        type="file"
        accept="image/avif,image/gif,image/jpeg,image/png,image/tiff,image/webp"
        onChange={(event) => void selectImage(event)}
      />
      <button
        className="image-glyph"
        type="button"
        aria-label="Insert image"
        aria-busy={uploading}
        disabled={disabled || uploading}
        onClick={() => input.current?.click()}
      >
        <MaterialSymbol name="add_photo_alternate" />
      </button>
      {error ? <span className="image-insert-error" role="alert">IMAGE UPLOAD FAILED</span> : null}
    </div>
  );
}
