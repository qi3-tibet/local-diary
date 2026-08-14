import { expect, it, vi } from "vitest";
import {
  createDesktopHarness,
  hasExplicitUserDataDir,
  resolveDesktopRoots,
  resolveDiaryDataHome,
} from "../src/main.js";

function fakeApp() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(async () => undefined),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    quit: vi.fn(),
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

it("uses clean Local Diary data but reuses an existing pre-release diary", () => {
  const current = "C:\\Users\\Ada\\AppData\\Roaming\\Local Diary";
  const appData = "C:\\Users\\Ada\\AppData\\Roaming";
  const legacy = "C:\\Users\\Ada\\AppData\\Roaming\\@diary\\desktop";

  expect(resolveDiaryDataHome(current, appData, () => false)).toBe(current);
  expect(resolveDiaryDataHome(
    current,
    appData,
    (candidate) => candidate === `${legacy}\\data`,
  )).toBe(legacy);
  expect(resolveDiaryDataHome(
    current,
    appData,
    (candidate) => candidate === `${current}\\data` || candidate === `${legacy}\\data`,
  )).toBe(current);
  expect(resolveDiaryDataHome(
    "C:\\Temp\\OwnedReleaseSmoke",
    appData,
    (candidate) => candidate === `${legacy}\\data`,
    false,
  )).toBe("C:\\Temp\\OwnedReleaseSmoke");
});

it("detects both explicit Electron user-data directory argument forms", () => {
  expect(hasExplicitUserDataDir(["Local Diary.exe", "--user-data-dir=C:\\Temp\\Diary"])).toBe(true);
  expect(hasExplicitUserDataDir(["Local Diary.exe", "--user-data-dir", "C:\\Temp\\Diary"])).toBe(true);
  expect(hasExplicitUserDataDir(["Local Diary.exe", "--browser"])).toBe(false);
});

it("defaults backups to a clear Documents location outside application data", () => {
  const roots = resolveDesktopRoots(
    "C:\\Users\\Ada\\AppData\\Roaming\\Local Diary",
    "C:\\Program Files\\Local Diary\\resources\\app.asar",
    "C:\\Program Files\\Local Diary\\resources",
    "C:\\Users\\Ada\\Documents",
  );

  expect(roots.dataRoot).toBe("C:\\Users\\Ada\\AppData\\Roaming\\Local Diary\\data");
  expect(roots.backupRoot).toBe("C:\\Users\\Ada\\Documents\\Local Diary Backups");
});

it("uses workspace web assets when an Electron preview has no packaged web bundle", () => {
  const electronResources = "C:\\Workspace\\node_modules\\electron\\dist\\resources";
  const roots = resolveDesktopRoots(
    "C:\\Users\\Ada\\AppData\\Roaming\\Local Diary",
    "C:\\Workspace\\apps\\desktop",
    electronResources,
    "C:\\Users\\Ada\\Documents",
    undefined,
    (candidate) => candidate !== `${electronResources}\\web`,
  );

  expect(roots.webAssetsRoot).toBe("C:\\Workspace\\apps\\web\\dist");
});

it("allows an explicit absolute backup root for isolated release verification", () => {
  const roots = resolveDesktopRoots(
    "C:\\Temp\\LocalDiarySmoke",
    "C:\\LocalDiary\\resources\\app.asar",
    "C:\\LocalDiary\\resources",
    "C:\\Users\\Ada\\Documents",
    "C:\\Temp\\LocalDiarySmoke\\backups",
  );

  expect(roots.backupRoot).toBe("C:\\Temp\\LocalDiarySmoke\\backups");
});

it("rejects a relative backup-root override", () => {
  expect(() => resolveDesktopRoots(
    "C:\\Temp\\LocalDiarySmoke",
    "C:\\LocalDiary\\resources\\app.asar",
    "C:\\LocalDiary\\resources",
    "C:\\Users\\Ada\\Documents",
    ".\\backups",
  )).toThrow("absolute");
});

it("routes desktop and browser shortcut launches through one running service", async () => {
  const app = fakeApp();
  const shell = { openExternal: vi.fn(async () => undefined) };
  const window = { isMinimized: vi.fn(() => false), restore: vi.fn(), focus: vi.fn() };
  const lifecycle = {
    start: vi.fn(async () => ({ host: "127.0.0.1" as const, url: "http://127.0.0.1:43127" })),
    stop: vi.fn(async () => undefined),
    state: vi.fn(() => "running"),
  };
  const createWindow = vi.fn(() => window);
  const harness = createDesktopHarness({
    argv: ["Local Diary.exe"],
    app,
    shell,
    lifecycle,
    createWindow,
    getWindows: () => [window],
  });

  await harness.run();
  app.emit("second-instance", {}, ["Local Diary.exe", "--browser"]);

  expect(lifecycle.start).toHaveBeenCalledTimes(1);
  expect(createWindow).toHaveBeenCalledTimes(1);
  expect(shell.openExternal).toHaveBeenCalledTimes(1);
  expect(shell.openExternal).toHaveBeenCalledWith("http://127.0.0.1:43127");
});

it("opens a desktop window from an already-running browser-mode service", async () => {
  const app = fakeApp();
  const shell = { openExternal: vi.fn(async () => undefined) };
  const window = { isMinimized: vi.fn(() => false), restore: vi.fn(), focus: vi.fn() };
  const lifecycle = {
    start: vi.fn(async () => ({ host: "127.0.0.1" as const, url: "http://127.0.0.1:43127" })),
    stop: vi.fn(async () => undefined),
    state: vi.fn(() => "running"),
  };
  const createWindow = vi.fn(() => window);
  const harness = createDesktopHarness({
    argv: ["Local Diary.exe", "--browser"],
    app,
    shell,
    lifecycle,
    createWindow,
    getWindows: () => [],
  });

  await harness.run();
  app.emit("second-instance", {}, ["Local Diary.exe"]);
  await vi.waitFor(() => expect(createWindow).toHaveBeenCalledTimes(1));

  expect(lifecycle.start).toHaveBeenCalledTimes(1);
  expect(shell.openExternal).toHaveBeenCalledTimes(1);
  expect(createWindow).toHaveBeenCalledWith("http://127.0.0.1:43127");
});

it("recreates a desktop window after a browser-owned window was closed", async () => {
  const app = fakeApp();
  const shell = { openExternal: vi.fn(async () => undefined) };
  let destroyed = false;
  let created = false;
  const window = {
    isDestroyed: vi.fn(() => destroyed),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    focus: vi.fn(),
  };
  const lifecycle = {
    start: vi.fn(async () => ({ host: "127.0.0.1" as const, url: "http://127.0.0.1:43127" })),
    stop: vi.fn(async () => undefined),
    state: vi.fn(() => "running"),
  };
  const createWindow = vi.fn(() => {
    created = true;
    return window;
  });
  const harness = createDesktopHarness({
    argv: ["Local Diary.exe", "--browser"],
    app,
    shell,
    lifecycle,
    createWindow,
    getWindows: () => created && !destroyed ? [window] : [],
  });

  await harness.run();
  app.emit("second-instance", {}, ["Local Diary.exe"]);
  await vi.waitFor(() => expect(createWindow).toHaveBeenCalledTimes(1));
  destroyed = true;
  app.emit("second-instance", {}, ["Local Diary.exe"]);
  await vi.waitFor(() => expect(createWindow).toHaveBeenCalledTimes(2));

  expect(lifecycle.start).toHaveBeenCalledTimes(1);
});
