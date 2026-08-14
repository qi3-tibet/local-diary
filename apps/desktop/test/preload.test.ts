import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

function loadPreload() {
  const listeners = new Map<string, (...args: any[]) => void>();
  let exposed: Record<string, unknown> | undefined;
  const contextBridge = {
    exposeInMainWorld: vi.fn((_name: string, api: Record<string, unknown>) => {
      exposed = api;
    }),
  };
  const ipcRenderer = {
    invoke: vi.fn(),
    on: vi.fn((channel: string, listener: (...args: any[]) => void) => {
      listeners.set(channel, listener);
    }),
    removeListener: vi.fn((channel: string, listener: (...args: any[]) => void) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    }),
    send: vi.fn(),
  };
  const source = readFileSync(new URL("../src/preload.cts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  Function("require", "exports", compiled)(
    (specifier: string) => {
      if (specifier === "electron") return { contextBridge, ipcRenderer };
      throw new Error(`Unexpected preload import: ${specifier}`);
    },
    {},
  );
  return { exposed, ipcRenderer, listeners };
}

describe("desktop preload close bridge", () => {
  let preload: ReturnType<typeof loadPreload>;

  beforeEach(() => {
    preload = loadPreload();
  });

  it("awaits the allow-listed flush listener and sends only its boolean result", async () => {
    let resolve!: (ok: boolean) => void;
    const listener = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const api = preload.exposed as {
      onFlushBeforeClose(listener: () => Promise<boolean>): () => void;
    };
    api.onFlushBeforeClose(listener);

    preload.listeners.get("diary:flush-before-close")?.({ hidden: "event" }, 17);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith());
    expect(preload.ipcRenderer.send).not.toHaveBeenCalled();

    resolve(true);
    await vi.waitFor(() => expect(preload.ipcRenderer.send).toHaveBeenCalledWith(
      "diary:flush-before-close:result",
      { ok: true, requestId: 17 },
    ));
  });

  it("reports listener failures as false and removes its subscription on cleanup", async () => {
    const api = preload.exposed as {
      onFlushBeforeClose(listener: () => Promise<boolean>): () => void;
    };
    const listener = vi.fn(async () => { throw new Error("save failed"); });
    const cleanup = api.onFlushBeforeClose(listener);

    preload.listeners.get("diary:flush-before-close")?.({ hidden: "event" }, 29);
    await vi.waitFor(() => expect(preload.ipcRenderer.send).toHaveBeenCalledWith(
      "diary:flush-before-close:result",
      { ok: false, requestId: 29 },
    ));

    cleanup();
    expect(preload.ipcRenderer.removeListener).toHaveBeenCalledWith(
      "diary:flush-before-close",
      expect.any(Function),
    );
    expect(preload.listeners.has("diary:flush-before-close")).toBe(false);
  });
});
