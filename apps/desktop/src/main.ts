import { existsSync } from "node:fs";
import path from "node:path";
import {
  createServiceLifecycle,
  type LocalService,
  type LocalServiceOptions,
} from "./service-lifecycle.js";
import { createDiaryWindow } from "./window.js";

type DesktopWindow = {
  isDestroyed?(): boolean;
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
  let desktopWindowQueued = false;
  let windowStarting: Promise<DesktopWindow> | undefined;

  const focusExistingWindow = () => {
    if (window?.isDestroyed?.()) window = undefined;
    const target = window ?? options.getWindows().find((candidate) => !candidate.isDestroyed?.());
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

  const openDesktopWindow = async (reuseExisting = true) => {
    if (reuseExisting && focusExistingWindow()) return window;
    if (windowStarting) return windowStarting;
    if (!service) {
      desktopWindowQueued = true;
      return undefined;
    }
    const pending = Promise.resolve(options.createWindow(service.url));
    windowStarting = pending;
    try {
      window = await pending;
      return window;
    } finally {
      if (windowStarting === pending) windowStarting = undefined;
    }
  };

  options.app.on("second-instance", (_event: unknown, argv: string[] = []) => {
    if (argv.includes("--browser")) {
      if (service) void options.shell.openExternal(service.url);
      else browserOpenQueued = true;
      return;
    }
    void openDesktopWindow();
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
    if (window || !service) return;
    void openDesktopWindow();
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
        if (desktopWindowQueued) {
          desktopWindowQueued = false;
          await openDesktopWindow();
        }
        return;
      }
      await openDesktopWindow(false);
      if (browserOpenQueued) {
        browserOpenQueued = false;
        await options.shell.openExternal(service.url);
      }
    },
    async stop(): Promise<void> {
      await closeServiceThenQuit();
    },
  };
}

export type DesktopRoots = LocalServiceOptions & { webAssetsRoot: string };

export function resolveDiaryDataHome(
  currentUserData: string,
  appData: string,
  exists: (candidate: string) => boolean = existsSync,
): string {
  const current = path.resolve(currentUserData);
  const legacy = path.join(path.resolve(appData), "@diary", "desktop");
  if (exists(path.join(current, "data"))) return current;
  if (
    current.localeCompare(legacy, undefined, { sensitivity: "accent" }) !== 0
    && exists(path.join(legacy, "data"))
  ) {
    return legacy;
  }
  return current;
}

export function resolveDesktopRoots(
  userData: string,
  appPath: string,
  resourcesPath?: string,
  documentsPath?: string,
  backupRootOverride?: string,
): DesktopRoots {
  const externalRoot = path.resolve(userData);
  if (backupRootOverride && !path.isAbsolute(backupRootOverride)) {
    throw new Error("Backup root override must be absolute.");
  }
  return {
    dataRoot: path.join(externalRoot, "data"),
    backupRoot: backupRootOverride
      ? path.resolve(backupRootOverride)
      : documentsPath
      ? path.join(path.resolve(documentsPath), "Local Diary Backups")
      : path.join(externalRoot, "backups"),
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
  const diaryDataHome = resolveDiaryDataHome(
    electron.app.getPath("userData"),
    electron.app.getPath("appData"),
  );
  const roots = resolveDesktopRoots(
    diaryDataHome,
    electron.app.getAppPath(),
    process.resourcesPath,
    electron.app.getPath("documents"),
    process.env.DIARY_BACKUP_ROOT?.trim() || undefined,
  );
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
