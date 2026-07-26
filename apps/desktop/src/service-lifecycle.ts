import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

export type LocalServer = {
  listen(options: { host: "127.0.0.1"; port: 0 }): Promise<string>;
  close(): Promise<void>;
};

export type LocalServiceOptions = {
  dataRoot?: string;
  backupRoot?: string;
  tempRoot?: string;
  logRoot?: string;
};

export type LocalService = { host: "127.0.0.1"; url: string };
export type ServiceState = "stopped" | "starting" | "running" | "stopping";
export type ServiceFactory = (options: LocalServiceOptions) => LocalServer;

type StaticServer = LocalServer & {
  get?: (route: string, handler: (request: { params: { "*"?: string } }, reply: StaticReply) => unknown) => void;
};

type StaticReply = {
  code(status: number): StaticReply;
  type(contentType: string): StaticReply;
  send(payload?: unknown): unknown;
};

export type ServiceLifecycleOptions = LocalServiceOptions & {
  webAssetsRoot?: string;
};

export function createServiceLifecycle(
  factory: ServiceFactory,
  options: ServiceLifecycleOptions = {},
) {
  let running: { server: LocalServer; service: LocalService } | undefined;
  let starting: Promise<LocalService> | undefined;
  let stopping: Promise<void> | undefined;

  const start = async (): Promise<LocalService> => {
    if (running) return running.service;
    if (starting) return starting;
    if (stopping) {
      await stopping;
      return start();
    }

    const pending = (async () => {
      const server = factory(options);
      try {
        if (options.webAssetsRoot) attachWebAssets(server as StaticServer, options.webAssetsRoot);
        const url = await server.listen({ host: "127.0.0.1", port: 0 });
        assertLoopbackUrl(url);
        const service = { host: "127.0.0.1" as const, url };
        running = { server, service };
        return service;
      } catch (error) {
        await server.close().catch(() => undefined);
        throw error;
      }
    })();
    starting = pending;
    try {
      return await pending;
    } finally {
      if (starting === pending) starting = undefined;
    }
  };

  const stop = async (): Promise<void> => {
    if (stopping) return stopping;
    const pending = (async () => {
      if (starting) await starting.catch(() => undefined);
      const current = running;
      running = undefined;
      if (current) await current.server.close();
    })();
    stopping = pending;
    try {
      await pending;
    } finally {
      if (stopping === pending) stopping = undefined;
    }
  };

  return {
    start,
    stop,
    state: (): ServiceState => {
      if (stopping) return "stopping";
      if (running) return "running";
      if (starting) return "starting";
      return "stopped";
    },
  };
}

function assertLoopbackUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Local service must return a canonical loopback URL.");
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error("Local service must return a canonical loopback URL.");
}

function attachWebAssets(server: StaticServer, root: string): void {
  if (!server.get || !existsSync(root)) return;
  const resolvedRoot = path.resolve(root);
  server.get("/*", async (request, reply) => {
    const requested = request.params["*"] ?? "";
    const file = await assetFile(resolvedRoot, requested);
    if (!file) return reply.code(404).send();
    return reply.type(contentType(file)).send(createReadStream(file));
  });
}

async function assetFile(root: string, requested: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || path.isAbsolute(decoded)) return null;
  const relative = decoded === "" || !path.extname(decoded) ? "index.html" : decoded;
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  try {
    return (await stat(candidate)).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function contentType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}
