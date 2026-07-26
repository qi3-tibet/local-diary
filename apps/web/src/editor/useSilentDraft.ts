import type { DraftInput } from "@diary/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

type SilentDraftController = {
  state: "idle" | "saving" | "failed" | "retrying" | "recovered";
  finalize(value: DraftInput): Promise<void>;
  resume(): void;
  retry(): Promise<void>;
  dismissRecovery(): void;
};

export function useSilentDraft(
  input: DraftInput,
  save: (value: DraftInput) => Promise<unknown>,
  enabled = true,
): SilentDraftController {
  const latest = useRef(input);
  const autosaveBaseline = useRef(input);
  const generation = useRef(0);
  const paused = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const hadFailure = useRef(false);
  const [state, setState] = useState<SilentDraftController["state"]>("idle");

  const enqueue = useCallback((value: DraftInput): Promise<void> => {
    const currentGeneration = ++generation.current;
    const recovering = hadFailure.current;
    const operation = queue.current
      .catch(() => undefined)
      .then(async () => {
        if (paused.current || currentGeneration !== generation.current) return;
        setState(recovering ? "retrying" : "saving");
        try {
          await save(value);
          if (currentGeneration === generation.current) {
            hadFailure.current = false;
            setState(recovering ? "recovered" : "idle");
          }
        } catch (error) {
          if (currentGeneration === generation.current) {
            hadFailure.current = true;
            setState("failed");
          }
          throw error;
        }
      });
    queue.current = operation;
    return operation.then(() => undefined);
  }, [save]);

  useEffect(() => {
    latest.current = input;
    if (!enabled) return;
    if (input === autosaveBaseline.current) return;
    autosaveBaseline.current = input;

    const handle = window.setTimeout(() => {
      void enqueue(latest.current).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(handle);
  }, [enabled, enqueue, input]);

  const finalize = useCallback((value: DraftInput): Promise<void> => {
    paused.current = true;
    const currentGeneration = ++generation.current;
    const recovering = hadFailure.current;
    setState(recovering ? "retrying" : "saving");
    const finalSave = queue.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await save(value);
          if (currentGeneration === generation.current) {
            hadFailure.current = false;
            setState(recovering ? "recovered" : "idle");
          }
        } catch (error) {
          if (currentGeneration === generation.current) {
            hadFailure.current = true;
            setState("failed");
          }
          throw error;
        }
      })
      .then(() => undefined);
    queue.current = finalSave;
    return finalSave;
  }, [save]);

  const resume = useCallback((): void => {
    paused.current = false;
  }, []);

  const retry = useCallback((): Promise<void> => {
    paused.current = false;
    return enqueue(latest.current);
  }, [enqueue]);

  const dismissRecovery = useCallback((): void => {
    setState((current) => current === "recovered" ? "idle" : current);
  }, []);

  return { state, finalize, resume, retry, dismissRecovery };
}
