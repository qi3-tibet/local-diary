import type { DraftInput } from "@diary/contracts";
import { useCallback, useEffect, useRef } from "react";

type SilentDraftController = {
  finalize(value: DraftInput): Promise<void>;
  resume(): void;
};

export function useSilentDraft(
  input: DraftInput,
  save: (value: DraftInput) => Promise<unknown>,
  enabled = true,
): SilentDraftController {
  const latest = useRef(input);
  const generation = useRef(0);
  const paused = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const enqueue = useCallback((value: DraftInput): void => {
    const currentGeneration = ++generation.current;
    queue.current = queue.current
      .catch(() => undefined)
      .then(() => {
        if (paused.current || currentGeneration !== generation.current) return;
        return save(value);
      });
  }, [save]);

  useEffect(() => {
    latest.current = input;
    if (!enabled) return;

    const handle = window.setTimeout(() => {
      enqueue(latest.current);
    }, 500);
    return () => window.clearTimeout(handle);
  }, [enabled, enqueue, input]);

  const finalize = useCallback((value: DraftInput): Promise<void> => {
    paused.current = true;
    ++generation.current;
    const finalSave = queue.current
      .catch(() => undefined)
      .then(() => save(value))
      .then(() => undefined);
    queue.current = finalSave;
    return finalSave;
  }, [save]);

  const resume = useCallback((): void => {
    paused.current = false;
  }, []);

  return { finalize, resume };
}
