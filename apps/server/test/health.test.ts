import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { resolveServerConfig } from "../src/config.js";

describe("local service", () => {
  const servers: Array<ReturnType<typeof buildServer>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

  it("reports health without exposing a LAN host", async () => {
    expect(resolveServerConfig({})).toMatchObject({ host: "127.0.0.1" });
    const server = buildServer();
    servers.push(server);
    const response = await server.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", apiVersion: 1 });
  });
});
