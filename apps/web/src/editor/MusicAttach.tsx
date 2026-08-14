import { useRef } from "react";
import { MaterialSymbol } from "../icons/MaterialSymbol";

type MusicAttachProps = {
  disabled?: boolean;
  onSelect(file: File): void | Promise<void>;
};

export function MusicAttach({ disabled = false, onSelect }: MusicAttachProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="music-attach">
      <input
        ref={input}
        hidden
        accept="audio/mpeg,.mp3"
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onSelect(file);
          event.target.value = "";
        }}
      />
      <button
        className="music-attach-glyph"
        type="button"
        aria-label="Attach MP3"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <MaterialSymbol name="library_music" />
      </button>
    </div>
  );
}
