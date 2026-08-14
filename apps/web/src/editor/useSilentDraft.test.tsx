// @vitest-environment jsdom

import type { DraftInput } from "@diary/contracts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSilentDraft } from "./useSilentDraft";

type SavedDraft = DraftInput & { id: string };

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const draft = (markdown: string): DraftInput => ({
  title: "雨后的街道",
  markdown,
  tags: [],
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSilentDraft", () => {
  it("does not persist an unchanged initial value", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (value: DraftInput): Promise<SavedDraft> => ({ id: "draft-initial", ...value }));
    renderHook(() => useSilentDraft(draft(""), save));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(save).not.toHaveBeenCalled();
  });

  it("waits for an in-flight autosave before persisting the final latest value", async () => {
    vi.useFakeTimers();
    const olderSave = deferred<SavedDraft>();
    const finalSave = deferred<SavedDraft>();
    const save = vi
      .fn<(value: ReturnType<typeof draft>) => Promise<SavedDraft>>()
      .mockImplementationOnce(() => olderSave.promise)
      .mockImplementationOnce(() => finalSave.promise);
    const initial = draft("");
    const older = draft("较早的内容");
    const latest = draft("最终内容");
    const { result, rerender } = renderHook(
      ({ value }) => useSilentDraft(value, save),
      { initialProps: { value: initial } },
    );

    rerender({ value: older });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).toHaveBeenCalledWith(older);

    rerender({ value: latest });
    let finalize!: Promise<SavedDraft | undefined>;
    act(() => {
      finalize = result.current.finalize(latest);
    });
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);

    olderSave.resolve({ id: "draft-older", ...older });
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenNthCalledWith(2, latest);

    const savedFinal = { id: "draft-final", ...latest };
    finalSave.resolve(savedFinal);
    await act(async () => {
      await expect(finalize).resolves.toEqual(savedFinal);
      await vi.runAllTimersAsync();
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("does not persist an unchanged draft when finalized", async () => {
    const value = draft("already saved");
    const save = vi.fn<(value: DraftInput) => Promise<SavedDraft>>();
    const { result } = renderHook(() => useSilentDraft(value, save));

    await act(async () => {
      await expect(result.current.finalize(value)).resolves.toBeUndefined();
    });

    expect(save).not.toHaveBeenCalled();
  });

  it("exposes failure, retrying, recovered, and explicit recovery dismissal states", async () => {
    vi.useFakeTimers();
    const recoveredSave = deferred<SavedDraft>();
    const save = vi
      .fn<(value: ReturnType<typeof draft>) => Promise<SavedDraft>>()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockImplementationOnce(() => recoveredSave.promise);
    const initial = draft("");
    const first = draft("尚未保存");
    const recovered = draft("重试后的内容");
    const { result, rerender } = renderHook(
      ({ value }) => useSilentDraft(value, save),
      { initialProps: { value: initial } },
    );

    rerender({ value: first });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.state).toBe("failed");

    rerender({ value: recovered });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.state).toBe("retrying");
    expect(save).toHaveBeenNthCalledWith(2, recovered);

    recoveredSave.resolve({ id: "draft-recovered", ...recovered });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state).toBe("recovered");

    act(() => result.current.dismissRecovery());
    expect(result.current.state).toBe("idle");
  });

  it("keeps finalize rejected after a failed final persistence", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (): Promise<SavedDraft> => {
      throw new Error("disk unavailable");
    });
    const value = draft("不能丢失");
    const { result, rerender } = renderHook(
      ({ current }) => useSilentDraft(current, save),
      { initialProps: { current: draft("") } },
    );

    rerender({ current: value });

    await act(async () => {
      await expect(result.current.finalize(value)).rejects.toThrow("disk unavailable");
    });
    expect(result.current.state).toBe("failed");
  });
});
