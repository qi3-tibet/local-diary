import type { DraftInput } from "@diary/contracts";
import { useEffect, useRef } from "react";

export function useSilentDraft(
  input: DraftInput,
  save: (value: DraftInput) => Promise<unknown>,
  enabled = true,
): void {
  const latest = useRef(input);

  useEffect(() => {
    latest.current = input;
    if (!enabled) return;

    const handle = window.setTimeout(() => {
      void save(latest.current).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(handle);
  }, [enabled, input, save]);
}
