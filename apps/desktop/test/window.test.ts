import { describe, expect, it, vi } from "vitest";
import { createDiaryWindow, type WindowRuntime } from "../src/window.js";

function windowRuntime() {
  let openHandler!: (details: { url: string }) => { action: "deny" };
  let navigationHandler!: (event: { preventDefault(): void }, target: string) => void;
  const windowListeners = new Map<string, Array<(...args: any[]) => void>>();
  const ipcListeners = new Map<string, Array<(...args: any[]) => void>>();
  let windowOptions!: ConstructorParameters<WindowRuntime["BrowserWindow"]>[0];
  const shell = { openExternal: vi.fn(async () => undefined) };
  const browserWindow = {
    loadURL: vi.fn(async () => undefined), show: vi.fn(),
    isMinimized: vi.fn(() => false), restore: vi.fn(), focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      windowListeners.set(event, [...(windowListeners.get(event) ?? []), listener]);
    }),
    removeListener: vi.fn((event: string, listener: (...args: any[]) => void) => {
      windowListeners.set(event, (windowListeners.get(event) ?? []).filter((candidate) => candidate !== listener));
    }),
    close: vi.fn(() => {
      const event = { preventDefault: vi.fn() };
      for (const listener of windowListeners.get("close") ?? []) listener(event);
      if (!event.preventDefault.mock.calls.length) {
        for (const listener of windowListeners.get("closed") ?? []) listener();
      }
    }),
    webContents: {
      setWindowOpenHandler: vi.fn((handler) => { openHandler = handler; }),
      on: vi.fn((_event, handler) => { navigationHandler = handler; }),
      send: vi.fn(),
    },
  };
  class BrowserWindow {
    constructor(options: ConstructorParameters<WindowRuntime["BrowserWindow"]>[0]) {
      windowOptions = options;
      return browserWindow;
    }
  }
  return {
    runtime: {
      BrowserWindow,
      shell,
      ipcMain: {
        on: vi.fn((event: string, listener: (...args: any[]) => void) => {
          ipcListeners.set(event, [...(ipcListeners.get(event) ?? []), listener]);
        }),
        removeListener: vi.fn((event: string, listener: (...args: any[]) => void) => {
          ipcListeners.set(event, (ipcListeners.get(event) ?? []).filter((candidate) => candidate !== listener));
        }),
      },
    } as unknown as WindowRuntime,
    browserWindow,
    shell,
    windowOptions: () => windowOptions,
    navigate(url: string) {
      const event = { preventDefault: vi.fn() };
      navigationHandler(event, url);
      return event;
    },
    open(url: string) { return openHandler({ url }); },
    close() {
      browserWindow.close();
      return { listenerCount: (ipcListeners.get("diary:flush-before-close:result") ?? []).length };
    },
    acknowledge(ok: boolean, requestId = browserWindow.webContents.send.mock.calls.at(-1)?.[1]) {
      for (const listener of ipcListeners.get("diary:flush-before-close:result") ?? []) {
        listener({ sender: browserWindow.webContents }, { ok, requestId });
      }
    },
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
    expect(harness.windowOptions().webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: expect.stringMatching(/[\\/]preload\.cjs$/),
    });
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

describe("diary window close coordination", () => {
  it("prevents the first close and retries it only after a successful renderer flush", async () => {
    const harness = windowRuntime();
    await createDiaryWindow("http://127.0.0.1:45678", harness.runtime);

    const close = harness.close();

    expect(harness.browserWindow.webContents.send).toHaveBeenCalledWith(
      "diary:flush-before-close",
      expect.any(Number),
    );
    expect(harness.browserWindow.close).toHaveBeenCalledTimes(1);
    expect(close.listenerCount).toBe(1);

    harness.acknowledge(true);

    expect(harness.browserWindow.close).toHaveBeenCalledTimes(2);
    expect(harness.runtime.ipcMain.removeListener).toHaveBeenCalledWith(
      "diary:flush-before-close:result",
      expect.any(Function),
    );
  });

  it("keeps the native window open after a refused renderer flush", async () => {
    const harness = windowRuntime();
    await createDiaryWindow("http://127.0.0.1:45678", harness.runtime);

    harness.close();
    harness.acknowledge(false);

    expect(harness.browserWindow.close).toHaveBeenCalledTimes(1);
  });

  it("does not send duplicate flush requests while a close is pending", async () => {
    const harness = windowRuntime();
    await createDiaryWindow("http://127.0.0.1:45678", harness.runtime);

    harness.close();
    harness.close();

    expect(harness.browserWindow.webContents.send).toHaveBeenCalledTimes(1);
    harness.acknowledge(false);
  });

  it("rejects a delayed acknowledgement from a timed-out close attempt", async () => {
    vi.useFakeTimers();
    try {
      const harness = windowRuntime();
      const window = await createDiaryWindow("http://127.0.0.1:45678", harness.runtime);

      const firstClose = window.requestClose();
      const firstRequestId = harness.browserWindow.webContents.send.mock.calls.at(-1)?.[1];
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(firstClose).resolves.toBe(false);

      const secondClose = window.requestClose();
      const secondRequestId = harness.browserWindow.webContents.send.mock.calls.at(-1)?.[1];
      harness.acknowledge(true, firstRequestId);
      expect(harness.browserWindow.close).toHaveBeenCalledTimes(2);

      harness.acknowledge(false, secondRequestId);
      await expect(secondClose).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
