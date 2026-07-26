import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";

describe("loopback request security", () => {
  const roots: string[] = [];
  const servers: Array<ReturnType<typeof buildServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it("rejects DNS-rebinding Host values before API data can be read", async () => {
    const { port } = await listen();

    const response = await get(port, "/api/v1/entries", {
      Host: `attacker.example:${port}`,
    });
    const wrongPort = await get(port, "/api/v1/entries", {
      Host: `127.0.0.1:${port === 65535 ? port - 1 : port + 1}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('{"error":"LOOPBACK_REQUEST_REJECTED"}');
    expect(wrongPort.statusCode).toBe(403);
  });

  it("rejects foreign browser origins and cross-site fetch contexts", async () => {
    const { port } = await listen();

    const foreignOrigin = await get(port, "/api/v1/entries", {
      Host: `127.0.0.1:${port}`,
      Origin: "https://attacker.example",
      "Sec-Fetch-Site": "cross-site",
    });
    const forgedSameOriginWithCrossSiteContext = await get(port, "/api/v1/entries", {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "cross-site",
    });
    const loopbackButDifferentOrigin = await get(port, "/api/v1/entries", {
      Host: `localhost:${port}`,
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin",
    });
    const hostileMutation = await send(port, "/api/v1/draft", {
      Host: `127.0.0.1:${port}`,
      Origin: "https://attacker.example",
      "Sec-Fetch-Site": "cross-site",
      "Content-Type": "application/json",
    }, "PUT", JSON.stringify({
      title: "hostile",
      markdown: "must not persist",
      tags: [],
    }));

    expect(foreignOrigin.statusCode).toBe(403);
    expect(forgedSameOriginWithCrossSiteContext.statusCode).toBe(403);
    expect(loopbackButDifferentOrigin.statusCode).toBe(403);
    expect(hostileMutation.statusCode).toBe(403);
    expect((await get(port, "/api/v1/draft", {
      Host: `127.0.0.1:${port}`,
    })).body).toBe("null");
  });

  it("keeps canonical loopback browser, Electron, and originless CLI requests working", async () => {
    const { port } = await listen();

    const browser = await get(port, "/api/v1/health", {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin",
    });
    const localhost = await get(port, "/api/v1/health", {
      Host: `localhost:${port}`,
      Origin: `http://localhost:${port}`,
      "Sec-Fetch-Site": "same-origin",
    });
    const originless = await get(port, "/api/v1/health", {
      Host: `127.0.0.1:${port}`,
    });

    expect(browser.statusCode).toBe(200);
    expect(localhost.statusCode).toBe(200);
    expect(originless.statusCode).toBe(200);
  });

  async function listen(): Promise<{ port: number }> {
    const dataRoot = mkdtempSync(join(tmpdir(), "local-diary-request-security-"));
    roots.push(dataRoot);
    const server = buildServer({ dataRoot, scheduleBackups: false });
    servers.push(server);
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    return { port: Number(new URL(address).port) };
  }
});

function get(
  port: number,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number; body: string }> {
  return send(port, pathname, headers);
}

function send(
  port: number,
  pathname: string,
  headers: Record<string, string>,
  method = "GET",
  body?: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
