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
    },
  });
  const openExternal = (target: string) => {
    if (new URL(target).origin !== allowedOrigin) void electron.shell.openExternal(target);
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (new URL(targetUrl).origin === allowedOrigin) return;
    event.preventDefault();
    openExternal(targetUrl);
  });
  await window.loadURL(localUrl);
  window.show();
  return window;
}
