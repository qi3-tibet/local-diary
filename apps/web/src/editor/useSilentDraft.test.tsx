// @vitest-environment jsdom

import type { DraftInput } from "@diary/contracts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSilentDraft } from "./useSilentDraft";

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
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
  it("waits for an in-flight autosave before persisting the final latest value", async () => {
    vi.useFakeTimers();
    const olderSave = deferred();
    const finalSave = deferred();
    const save = vi
      .fn<(value: ReturnType<typeof draft>) => Promise<void>>()
      .mockImplementationOnce(() => olderSave.promise)
      .mockImplementationOnce(() => finalSave.promise);
    const older = draft("较早的内容");
    const latest = draft("最终内容");
    const { result, rerender } = renderHook(
      ({ value }) => useSilentDraft(value, save),
      { initialProps: { value: older } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).toHaveBeenCalledWith(older);

    rerender({ value: latest });
    let finalize!: Promise<void>;
    act(() => {
      finalize = result.current.finalize(latest);
    });
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);

    olderSave.resolve();
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenNthCalledWith(2, latest);

    finalSave.resolve();
    await act(async () => {
      await finalize;
      await vi.runAllTimersAsync();
    });
    expect(save).toHaveBeenCalledTimes(2);
  });
});
