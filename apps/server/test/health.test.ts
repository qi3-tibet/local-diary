import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { resolveServerConfig } from "../src/config.js";

describe("local service", () => {
  const servers: Array<ReturnType<typeof buildServer>> = [];
  const dataRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    dataRoots.splice(0).forEach((dataRoot) => rmSync(dataRoot, { recursive: true, force: true }));
  });

  it("reports health without exposing a LAN host", async () => {
    expect(resolveServerConfig({})).toMatchObject({ host: "127.0.0.1" });
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-test-"));
    dataRoots.push(dataRoot);
    const server = buildServer({ dataRoot });
    servers.push(server);
    const response = await server.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", apiVersion: 1 });
    expect(existsSync(path.join(dataRoot, "diary.sqlite"))).toBe(true);
  });
});
