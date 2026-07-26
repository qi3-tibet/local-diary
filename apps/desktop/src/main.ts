import path from "node:path";
import {
  createServiceLifecycle,
  type LocalService,
  type LocalServiceOptions,
} from "./service-lifecycle.js";
import { createDiaryWindow } from "./window.js";

type DesktopWindow = {
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
};

type AppEvent = { preventDefault(): void };
type DesktopApp = {
  requestSingleInstanceLock(): boolean;
  whenReady(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): void;
  quit(): void;
};

type DesktopShell = { openExternal(url: string): Promise<unknown> };
type ServiceLifecycle = {
  start(): Promise<LocalService>;
  stop(): Promise<void>;
  state(): string;
};

export type DesktopHarnessOptions = {
  argv: string[];
  app: DesktopApp;
  shell: DesktopShell;
  lifecycle: ServiceLifecycle;
  createWindow(url: string): Promise<DesktopWindow> | DesktopWindow;
  getWindows(): DesktopWindow[];
};

export function createDesktopHarness(options: DesktopHarnessOptions) {
  const browserMode = options.argv.includes("--browser");
  let service: LocalService | undefined;
  let window: DesktopWindow | undefined;
  let quitAfterShutdown = false;
  let shutdown: Promise<void> | undefined;
  let browserOpenQueued = false;

  const focusExistingWindow = () => {
    const target = window ?? options.getWindows().at(0);
    if (!target) return false;
    if (target.isMinimized()) target.restore();
    target.focus();
    return true;
  };

  const closeServiceThenQuit = () => {
    if (shutdown) return shutdown;
    shutdown = options.lifecycle.stop().catch(() => undefined).then(() => {
      quitAfterShutdown = true;
      options.app.quit();
    });
    return shutdown;
  };

  options.app.on("second-instance", () => {
    if (browserMode) {
      if (service) void options.shell.openExternal(service.url);
      else browserOpenQueued = true;
      return;
    }
    focusExistingWindow();
  });

  options.app.on("before-quit", (event: AppEvent) => {
    if (quitAfterShutdown) return;
    event.preventDefault();
    void closeServiceThenQuit();
  });

  options.app.on("window-all-closed", () => {
    if (!browserMode) options.app.quit();
  });

  options.app.on("activate", () => {
    if (browserMode || window || !service) return;
    void Promise.resolve(options.createWindow(service.url)).then((next) => { window = next; });
  });

  return {
    async run(): Promise<void> {
      if (!options.app.requestSingleInstanceLock()) {
        options.app.quit();
        return;
      }
      await options.app.whenReady();
      service = await options.lifecycle.start();
      if (browserMode) {
        await options.shell.openExternal(service.url);
        if (browserOpenQueued) {
          browserOpenQueued = false;
          await options.shell.openExternal(service.url);
        }
        return;
      }
      window = await options.createWindow(service.url);
    },
    async stop(): Promise<void> {
      await closeServiceThenQuit();
    },
  };
}

export type DesktopRoots = LocalServiceOptions & { webAssetsRoot: string };

export function resolveDesktopRoots(userData: string, appPath: string, resourcesPath?: string): DesktopRoots {
  const externalRoot = path.resolve(userData);
  return {
    dataRoot: path.join(externalRoot, "data"),
    backupRoot: path.join(externalRoot, "backups"),
    tempRoot: path.join(externalRoot, "temp"),
    logRoot: path.join(externalRoot, "logs"),
    webAssetsRoot: resourcesPath
      ? path.join(resourcesPath, "web")
      : path.resolve(appPath, "..", "web", "dist"),
  };
}

export async function runElectronMain(): Promise<void> {
  const electron = await import("electron");
  const { buildServer } = await import("@diary/server");
  const roots = resolveDesktopRoots(electron.app.getPath("userData"), electron.app.getAppPath(), process.resourcesPath);
  const lifecycle = createServiceLifecycle(
    (serviceOptions) => buildServer(serviceOptions),
    roots,
  );
  const harness = createDesktopHarness({
    argv: process.argv,
    app: electron.app,
    shell: electron.shell,
    lifecycle,
    createWindow: (url) => createDiaryWindow(url),
    getWindows: () => electron.BrowserWindow.getAllWindows(),
  });
  await harness.run();
}

export function isElectronLaunch(versions: NodeJS.ProcessVersions): boolean {
  return typeof versions.electron === "string";
}

if (isElectronLaunch(process.versions)) {
  void runElectronMain();
}
