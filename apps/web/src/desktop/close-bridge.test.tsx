// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFlushBeforeClose } from "./close-bridge";

function Probe({ listener }: { listener: () => Promise<boolean> }) {
  useFlushBeforeClose(listener);
  return null;
}

describe("renderer close bridge", () => {
  afterEach(() => {
    cleanup();
    delete window.diaryDesktop;
  });

  it("registers the current flush callback and cleans it up on unmount", async () => {
    let registered!: () => Promise<boolean>;
    const dispose = vi.fn();
    window.diaryDesktop = {
      chooseBackupDirectory: vi.fn(),
      onFlushBeforeClose: vi.fn((listener) => {
        registered = listener;
        return dispose;
      }),
    };
    const first = vi.fn(async () => true);
    const second = vi.fn(async () => false);

    const view = render(<Probe listener={first} />);
    view.rerender(<Probe listener={second} />);

    await expect(registered()).resolves.toBe(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
