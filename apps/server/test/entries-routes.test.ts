import { afterEach, describe, expect, it } from "vitest";
import { buildTestServer } from "@diary/test-support";

describe("entry routes", () => {
  const servers: ReturnType<typeof buildTestServer>[] = [];

  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

  it("silently updates one draft and timestamps only on DONE", async () => {
    const server = buildTestServer({ now: "2026-07-26T16:03:49.000Z" });
    servers.push(server);

    await server.inject({
      method: "PUT",
      url: "/api/v1/draft",
      payload: { title: "雨后的街道", markdown: "空气变凉了。", tags: ["散步"] },
    });
    const draft = await server.inject({ method: "GET", url: "/api/v1/draft" });
    expect(draft.json().publishedAt).toBeNull();

    const published = await server.inject({ method: "POST", url: "/api/v1/draft/publish" });
    expect(published.statusCode).toBe(201);
    expect(published.json()).toMatchObject({
      state: "published",
      publishedAt: "2026-07-27T00:03:00+08:00",
    });
  });

  it("rejects DONE until title and Markdown body are non-empty", async () => {
    const server = buildTestServer();
    servers.push(server);

    await server.inject({
      method: "PUT",
      url: "/api/v1/draft",
      payload: { title: " ", markdown: "", tags: [] },
    });
    const response = await server.inject({ method: "POST", url: "/api/v1/draft/publish" });
    expect(response.statusCode).toBe(422);
    expect(response.json().fields).toEqual(["title", "markdown"]);
  });

  it("lists published entries without the active draft", async () => {
    const server = buildTestServer({ now: "2026-07-26T16:03:49.000Z" });
    servers.push(server);

    await server.inject({
      method: "PUT",
      url: "/api/v1/draft",
      payload: { title: "已完成", markdown: "第一篇。", tags: [] },
    });
    await server.inject({ method: "POST", url: "/api/v1/draft/publish" });
    await server.inject({
      method: "PUT",
      url: "/api/v1/draft",
      payload: { title: "未完成", markdown: "第二篇。", tags: [] },
    });

    const entries = await server.inject({ method: "GET", url: "/api/v1/entries" });
    expect(entries.statusCode).toBe(200);
    expect(entries.json()).toMatchObject([{ title: "已完成", state: "published" }]);
    expect(entries.json()).toHaveLength(1);

    const calendar = await server.inject({ method: "GET", url: "/api/v1/entries/calendar" });
    expect(calendar.statusCode).toBe(200);
    expect(calendar.json()).toEqual({
      days: [{ day: "2026-07-27", totalEntries: 1 }],
    });
  });
});
