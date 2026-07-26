import { describe, expect, it, vi } from "vitest";
import { createDiaryWindow, type WindowRuntime } from "../src/window.js";

function windowRuntime() {
  let openHandler!: (details: { url: string }) => { action: "deny" };
  let navigationHandler!: (event: { preventDefault(): void }, target: string) => void;
  const shell = { openExternal: vi.fn(async () => undefined) };
  const browserWindow = {
    loadURL: vi.fn(async () => undefined), show: vi.fn(),
    isMinimized: vi.fn(() => false), restore: vi.fn(), focus: vi.fn(),
    webContents: {
      setWindowOpenHandler: vi.fn((handler) => { openHandler = handler; }),
      on: vi.fn((_event, handler) => { navigationHandler = handler; }),
    },
  };
  class BrowserWindow {
    constructor() { return browserWindow; }
  }
  return {
    runtime: { BrowserWindow, shell } as unknown as WindowRuntime,
    shell,
    navigate(url: string) {
      const event = { preventDefault: vi.fn() };
      navigationHandler(event, url);
      return event;
    },
    open(url: string) { return openHandler({ url }); },
  };
}

describe("secure diary window navigation", () => {
  it("keeps only the exact loopback origin in-window and hands off safe external links", async () => {
    const harness = windowRuntime();
    await createDiaryWindow("http://127.0.0.1:45678", harness.runtime);

    const sameOrigin = harness.navigate("http://127.0.0.1:45678/entries/one");
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
    const external = harness.navigate("https://example.com/diary");
    expect(external.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.shell.openExternal).toHaveBeenCalledWith("https://example.com/diary");
    expect(harness.open("http://127.0.0.1:45678/other")).toEqual({ action: "deny" });
  });

  it.each(["javascript:alert(1)", "file:///C:/secret.txt", "data:text/html,nope", "not a url"]) (
    "rejects unsafe or malformed navigation without opening it externally: %s",
    async (target) => {
      const harness = windowRuntime();
      await createDiaryWindow("http://127.0.0.1:45678", harness.runtime);

      const event = harness.navigate(target);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(harness.shell.openExternal).not.toHaveBeenCalled();
      expect(harness.open(target)).toEqual({ action: "deny" });
      expect(harness.shell.openExternal).not.toHaveBeenCalled();
    },
  );
});
