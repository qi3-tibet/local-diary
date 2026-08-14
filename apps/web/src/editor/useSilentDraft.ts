import type { DraftInput } from "@diary/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

type SilentDraftController<TSaved extends DraftInput> = {
  state: "idle" | "saving" | "failed" | "retrying" | "recovered";
  finalize(value: DraftInput): Promise<TSaved | undefined>;
  resume(): void;
  retry(): Promise<TSaved | undefined>;
  dismissRecovery(): void;
};

function sameDraft(left: DraftInput, right: DraftInput | undefined): boolean {
  if (!right) return false;
  return left.title === right.title
    && left.markdown === right.markdown
    && left.tags.length === right.tags.length
    && left.tags.every((tag, index) => tag === right.tags[index]);
}

export function useSilentDraft<TSaved extends DraftInput>(
  input: DraftInput,
  save: (value: DraftInput) => Promise<TSaved>,
  enabled = true,
): SilentDraftController<TSaved> {
  const latest = useRef(input);
  const autosaveBaseline = useRef(input);
  const lastPersisted = useRef<DraftInput>(input);
  const lastSaved = useRef<TSaved | undefined>(undefined);
  const generation = useRef(0);
  const paused = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const hadFailure = useRef(false);
  const [state, setState] = useState<SilentDraftController<TSaved>["state"]>("idle");

  const enqueue = useCallback((operation: () => Promise<TSaved | undefined>): Promise<TSaved | undefined> => {
    const queued = queue.current
      .catch(() => undefined)
      .then(operation);
    queue.current = queued;
    return queued;
  }, []);

  const persist = useCallback(async (
    value: DraftInput,
    currentGeneration: number,
    recovering: boolean,
  ): Promise<TSaved> => {
    setState(recovering ? "retrying" : "saving");
    try {
      const saved = await save(value);
      lastPersisted.current = value;
      lastSaved.current = saved;
      if (currentGeneration === generation.current) {
        hadFailure.current = false;
        setState(recovering ? "recovered" : "idle");
      }
      return saved;
    } catch (error) {
      if (currentGeneration === generation.current) {
        hadFailure.current = true;
        setState("failed");
      }
      throw error;
    }
  }, [save]);

  const schedulePersist = useCallback((value: DraftInput): Promise<TSaved | undefined> => {
    const currentGeneration = ++generation.current;
    const recovering = hadFailure.current;
    return enqueue(() => {
      if (paused.current) return Promise.resolve(undefined);
      return persist(value, currentGeneration, recovering);
    });
  }, [enqueue, persist]);

  const clearTimer = useCallback((): void => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  useEffect(() => {
    latest.current = input;
    if (!enabled) return;
    if (sameDraft(input, autosaveBaseline.current)) return;
    autosaveBaseline.current = input;

    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      void schedulePersist(latest.current).catch(() => undefined);
    }, 500);
    return clearTimer;
  }, [clearTimer, enabled, input, schedulePersist]);

  const finalize = useCallback((value: DraftInput): Promise<TSaved | undefined> => {
    paused.current = true;
    clearTimer();
    if (sameDraft(value, lastPersisted.current)) return Promise.resolve(lastSaved.current);
    const currentGeneration = ++generation.current;
    const recovering = hadFailure.current;
    return enqueue(() => persist(value, currentGeneration, recovering));
  }, [clearTimer, enqueue, persist]);

  const resume = useCallback((): void => {
    paused.current = false;
  }, []);

  const retry = useCallback((): Promise<TSaved | undefined> => {
    paused.current = false;
    return schedulePersist(latest.current);
  }, [schedulePersist]);

  const dismissRecovery = useCallback((): void => {
    setState((current) => current === "recovered" ? "idle" : current);
  }, []);

  return { state, finalize, resume, retry, dismissRecovery };
}
