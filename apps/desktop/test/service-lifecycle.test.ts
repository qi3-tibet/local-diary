import { describe, expect, it, vi } from "vitest";
import { createDesktopHarness, isElectronLaunch } from "../src/main.js";
import { createServiceLifecycle, type LocalServer } from "../src/service-lifecycle.js";

type FakeServer = LocalServer & {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function fakeServer(url = "http://127.0.0.1:45678"): FakeServer {
  return {
    listen: vi.fn(async () => url),
    close: vi.fn(async () => undefined),
  };
}

describe("local service lifecycle", () => {
  it("starts one loopback service for concurrent calls and closes it once", async () => {
    const server = fakeServer();
    const lifecycle = createServiceLifecycle(() => server);

    const [first, second] = await Promise.all([lifecycle.start(), lifecycle.start()]);

    expect(first).toEqual({ host: "127.0.0.1", url: "http://127.0.0.1:45678" });
    expect(second).toEqual(first);
    expect(server.listen).toHaveBeenCalledTimes(1);
    expect(server.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 0 });

    await Promise.all([lifecycle.stop(), lifecycle.stop()]);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(lifecycle.state()).toBe("stopped");
  });

  it("cleans up a failed start so a later start can retry", async () => {
    const failed = fakeServer();
    failed.listen.mockRejectedValueOnce(new Error("port unavailable"));
    const healthy = fakeServer("http://127.0.0.1:45679");
    const factory = vi.fn(() => (factory.mock.calls.length === 1 ? failed : healthy));
    const lifecycle = createServiceLifecycle(factory);

    await expect(lifecycle.start()).rejects.toThrow("port unavailable");
    expect(failed.close).toHaveBeenCalledTimes(1);
    expect(lifecycle.state()).toBe("stopped");

    await expect(lifecycle.start()).resolves.toEqual({ host: "127.0.0.1", url: "http://127.0.0.1:45679" });
    expect(healthy.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 0 });
  });

  it.each([
    "https://127.0.0.1:45679",
    "http://localhost:45679",
    "http://127.0.0.1:0",
    "http://127.0.0.1:45679/not-allowed",
    "http://user@127.0.0.1:45679",
  ])("rejects a non-canonical listen URL and remains retryable: %s", async (url) => {
    const rejected = fakeServer(url);
    const healthy = fakeServer("http://127.0.0.1:45679");
    const factory = vi.fn(() => (factory.mock.calls.length === 1 ? rejected : healthy));
    const lifecycle = createServiceLifecycle(factory);

    await expect(lifecycle.start()).rejects.toThrow("loopback URL");
    expect(rejected.close).toHaveBeenCalledTimes(1);
    expect(lifecycle.state()).toBe("stopped");
    await expect(lifecycle.start()).resolves.toEqual({ host: "127.0.0.1", url: "http://127.0.0.1:45679" });
  });

  it("waits for an in-flight start before it closes", async () => {
    let resolveListen!: (url: string) => void;
    const server = fakeServer();
    server.listen.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveListen = resolve; }));
    const lifecycle = createServiceLifecycle(() => server);

    const start = lifecycle.start();
    const stop = lifecycle.stop();
    resolveListen("http://127.0.0.1:45680");

    await Promise.all([start, stop]);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(lifecycle.state()).toBe("stopped");
  });
});

type FakeApp = ReturnType<typeof fakeApp>;

function fakeApp(lock = true) {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    requestSingleInstanceLock: vi.fn(() => lock),
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

function fakeLifecycle(url = "http://127.0.0.1:43127") {
  return {
    start: vi.fn(async () => ({ host: "127.0.0.1" as const, url })),
    stop: vi.fn<() => Promise<void>>(async () => {}),
    state: vi.fn(() => "running"),
  };
}

describe("desktop launch modes", () => {
  it("recognizes the packaged Electron main process without relying on argv[1]", () => {
    expect(isElectronLaunch({ electron: "43.2.0" } as NodeJS.ProcessVersions)).toBe(true);
    expect(isElectronLaunch({} as NodeJS.ProcessVersions)).toBe(false);
  });

  it("opens the default browser without creating a desktop window in browser mode", async () => {
    const app = fakeApp();
    const shell = { openExternal: vi.fn(async () => undefined) };
    const createWindow = vi.fn();
    const harness = createDesktopHarness({
      argv: ["--browser"],
      app,
      shell,
      lifecycle: fakeLifecycle(),
      createWindow,
      getWindows: () => [],
    });

    await harness.run();

    expect(shell.openExternal).toHaveBeenCalledWith("http://127.0.0.1:43127");
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("does not start a second service when the single-instance lock is unavailable", async () => {
    const app = fakeApp(false);
    const lifecycle = fakeLifecycle();
    const harness = createDesktopHarness({
      argv: [], app, shell: { openExternal: vi.fn() }, lifecycle,
      createWindow: vi.fn(), getWindows: () => [],
    });

    await harness.run();

    expect(lifecycle.start).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it("focuses and restores the existing window on a second launch", async () => {
    const app = fakeApp();
    const window = { isMinimized: vi.fn(() => true), restore: vi.fn(), focus: vi.fn() };
    const lifecycle = fakeLifecycle();
    const harness = createDesktopHarness({
      argv: [], app, shell: { openExternal: vi.fn() }, lifecycle,
      createWindow: vi.fn(() => window), getWindows: () => [window],
    });
    await harness.run();

    app.emit("second-instance", {}, ["app.exe"]);

    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("opens the browser for a second browser-mode launch that arrives during startup", async () => {
    const app = fakeApp();
    let releaseStart!: () => void;
    const lifecycle = fakeLifecycle();
    lifecycle.start.mockImplementationOnce(() => new Promise((resolve) => { releaseStart = () => resolve({ host: "127.0.0.1", url: "http://127.0.0.1:43127" }); }));
    const shell = { openExternal: vi.fn(async () => undefined) };
    const harness = createDesktopHarness({
      argv: ["--browser"], app, shell, lifecycle,
      createWindow: vi.fn(), getWindows: () => [],
    });

    const running = harness.run();
    await vi.waitFor(() => expect(lifecycle.start).toHaveBeenCalledTimes(1));
    app.emit("second-instance", {}, ["app.exe", "--browser"]);
    releaseStart();
    await running;

    expect(shell.openExternal).toHaveBeenCalledTimes(2);
    expect(shell.openExternal).toHaveBeenLastCalledWith("http://127.0.0.1:43127");
  });

  it("coordinates service shutdown before quitting", async () => {
    const app = fakeApp();
    let releaseStop!: () => void;
    const lifecycle = fakeLifecycle();
    lifecycle.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseStop = resolve; }));
    const harness = createDesktopHarness({
      argv: [], app, shell: { openExternal: vi.fn() }, lifecycle,
      createWindow: vi.fn(), getWindows: () => [],
    });
    await harness.run();
    const event = { preventDefault: vi.fn() };

    app.emit("before-quit", event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
    releaseStop();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
  });
});
