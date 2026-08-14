import { fileURLToPath } from "node:url";

type CloseEvent = { preventDefault(): void };
type IpcEvent = { sender: unknown };
type NativeDiaryWindow = {
  loadURL(url: string): Promise<void>;
  show(): void;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  isDestroyed(): boolean;
  close(): void;
  on(event: "close", listener: (event: CloseEvent) => void): void;
  on(event: "closed", listener: () => void): void;
  removeListener(event: "close", listener: (event: CloseEvent) => void): void;
  removeListener(event: "closed", listener: () => void): void;
  webContents: {
    on(event: "will-navigate", listener: (event: { preventDefault(): void }, targetUrl: string) => void): void;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
    isDestroyed?(): boolean;
    send(channel: "diary:flush-before-close", requestId: number): void;
  };
};

export type ManagedDiaryWindow = NativeDiaryWindow & {
  requestClose(): Promise<boolean>;
};

export type WindowRuntime = {
  BrowserWindow: new (options: {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    show: boolean;
    webPreferences: {
      contextIsolation: true;
      sandbox: true;
      nodeIntegration: false;
      preload: string;
    };
  }) => NativeDiaryWindow;
  ipcMain: {
    on(
      channel: "diary:flush-before-close:result",
      listener: (event: IpcEvent, result: unknown) => void,
    ): void;
    removeListener(
      channel: "diary:flush-before-close:result",
      listener: (event: IpcEvent, result: unknown) => void,
    ): void;
  };
  shell: { openExternal(url: string): Promise<unknown> };
};

export async function createDiaryWindow(localUrl: string, runtime?: WindowRuntime) {
  const electron = runtime ?? await import("electron") as unknown as WindowRuntime;
  const allowedOrigin = new URL(localUrl).origin;
  const window = new electron.BrowserWindow({
    width: 1160,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: resolvePreloadPath(),
    },
  });
  const handleTarget = (target: string): "local" | "external" | "reject" => {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return "reject";
    }
    if (parsed.origin === allowedOrigin) return "local";
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? "external" : "reject";
  };
  const openExternal = (target: string) => {
    if (handleTarget(target) === "external") void electron.shell.openExternal(target);
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (handleTarget(targetUrl) === "local") return;
    event.preventDefault();
    openExternal(targetUrl);
  });
  const coordinator = coordinateWindowClose(window, electron.ipcMain);
  try {
    await window.loadURL(localUrl);
  } catch (error) {
    coordinator.dispose();
    window.close();
    throw error;
  }
  window.show();
  return coordinator.window;
}

function coordinateWindowClose(
  window: NativeDiaryWindow,
  ipcMain: WindowRuntime["ipcMain"],
  timeoutMs = 5_000,
): { window: ManagedDiaryWindow; dispose(): void } {
  let closeAllowed = false;
  let flushInProgress = false;
  let disposed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<boolean> | undefined;
  let resolvePending: ((closed: boolean) => void) | undefined;
  let nextRequestId = 0;
  let activeRequestId: number | undefined;

  const settle = (closed: boolean) => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    flushInProgress = false;
    activeRequestId = undefined;
    const resolve = resolvePending;
    pending = undefined;
    resolvePending = undefined;
    resolve?.(closed);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    ipcMain.removeListener("diary:flush-before-close:result", handleResult);
    window.removeListener("close", handleClose);
    window.removeListener("closed", handleClosed);
  };

  const handleResult = (event: IpcEvent, result: unknown) => {
    if (!flushInProgress || event.sender !== window.webContents) return;
    if (!isAllowedResult(result, activeRequestId)) return;
    if (window.isDestroyed()) {
      settle(false);
      dispose();
      return;
    }
    if (!result.ok) {
      settle(false);
      return;
    }
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    flushInProgress = false;
    closeAllowed = true;
    window.close();
  };

  const handleClose = (event: CloseEvent) => {
    if (closeAllowed) return;
    event.preventDefault();
    if (flushInProgress || disposed || window.isDestroyed()) return;
    flushInProgress = true;
    activeRequestId = ++nextRequestId;
    timeout = setTimeout(() => settle(false), timeoutMs);
    try {
      if (window.webContents.isDestroyed?.()) {
        settle(false);
        return;
      }
      window.webContents.send("diary:flush-before-close", activeRequestId);
    } catch {
      settle(false);
    }
  };

  const handleClosed = () => {
    settle(closeAllowed);
    dispose();
  };

  const requestClose = (): Promise<boolean> => {
    if (window.isDestroyed()) return Promise.resolve(true);
    if (pending) return pending;
    pending = new Promise<boolean>((resolve) => {
      resolvePending = resolve;
    });
    window.close();
    return pending;
  };

  ipcMain.on("diary:flush-before-close:result", handleResult);
  window.on("close", handleClose);
  window.on("closed", handleClosed);
  return { window: Object.assign(window, { requestClose }), dispose };
}

function isAllowedResult(
  result: unknown,
  requestId: number | undefined,
): result is { ok: boolean; requestId: number } {
  if (typeof result !== "object" || result === null) return false;
  const candidate = result as { ok?: unknown; requestId?: unknown };
  return typeof candidate.ok === "boolean" && candidate.requestId === requestId;
}

export function resolvePreloadPath(moduleUrl = import.meta.url): string {
  return fileURLToPath(new URL("./preload.cjs", moduleUrl));
}
