import type { FastifyInstance } from "fastify";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

export function registerLoopbackRequestSecurity(server: FastifyInstance): void {
  server.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/")) return;

    const localPort = request.raw.socket.localPort;
    const authority = parseLoopbackAuthority(request.headers.host, localPort);
    const fetchSite = firstHeader(request.headers["sec-fetch-site"])?.toLowerCase();
    const origin = firstHeader(request.headers.origin);

    if (
      !authority
      || (fetchSite !== undefined && !ALLOWED_FETCH_SITES.has(fetchSite))
      || (origin !== undefined && !isSameOrigin(origin, authority.origin))
    ) {
      return reply.code(403).send({ error: "LOOPBACK_REQUEST_REJECTED" });
    }
  });
}

function parseLoopbackAuthority(
  hostHeader: string | undefined,
  localPort: number | undefined,
): { origin: string } | null {
  if (!hostHeader) return null;
  let parsed: URL;
  try {
    parsed = new URL(`http://${hostHeader}`);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : 80;
  if (
    !LOOPBACK_HOSTS.has(hostname)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
    || (localPort !== undefined && localPort > 0 && port !== localPort)
  ) {
    return null;
  }

  return { origin: parsed.origin.toLowerCase() };
}

function isSameOrigin(originHeader: string, expectedOrigin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:"
    && parsed.username === ""
    && parsed.password === ""
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === ""
    && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    && parsed.origin.toLowerCase() === expectedOrigin
  );
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
