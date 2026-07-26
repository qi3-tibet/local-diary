import { fileURLToPath } from "node:url";

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
  }) => {
    loadURL(url: string): Promise<void>;
    show(): void;
    isMinimized(): boolean;
    restore(): void;
    focus(): void;
    webContents: {
      on(event: "will-navigate", listener: (event: { preventDefault(): void }, targetUrl: string) => void): void;
      setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
    };
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
  await window.loadURL(localUrl);
  window.show();
  return window;
}

export function resolvePreloadPath(moduleUrl = import.meta.url): string {
  return fileURLToPath(new URL("./preload.cjs", moduleUrl));
}
