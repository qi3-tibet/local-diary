import { afterEach, describe, expect, it } from "vitest";
import { createBeijingClock } from "../src/time/beijing.js";
import { buildServer } from "../src/app.js";
import { EntryRepository } from "../src/entries/repository.js";
import { createTestDatabase } from "@diary/test-support";
import { purgeExpiredTrash } from "../src/trash/cleanup.js";

describe("search, editing, and trash", () => {
  const servers: Array<ReturnType<typeof buildServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  function createServer() {
    const database = createTestDatabase();
    const repository = new EntryRepository(database);
    const server = buildServer({
      database,
      clock: createBeijingClock(() => new Date("2026-07-26T00:00:00.000Z")),
    });
    servers.push(server);
    return { server, repository };
  }

  async function publish(
    server: ReturnType<typeof buildServer>,
    input = { title: "雨后的街道", markdown: "树叶上的水滴声", tags: ["散步"] },
  ) {
    await server.inject({ method: "PUT", url: "/api/v1/draft", payload: input });
    const response = await server.inject({ method: "POST", url: "/api/v1/draft/publish" });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  it("searches title, body substrings, and tags while entries expose no display title", async () => {
    const { server } = createServer();
    await publish(server);

    for (const query of ["雨后", "水滴", "树叶", "散步"]) {
      const response = await server.inject({
        method: "GET",
        url: `/api/v1/search?q=${encodeURIComponent(query)}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().items).toHaveLength(1);
    }

    const timeline = await server.inject({ method: "GET", url: "/api/v1/entries" });
    expect(timeline.json()[0]).not.toHaveProperty("displayTitle");
  });

  it("edits published content without changing its publication time", async () => {
    const { server } = createServer();
    const entry = await publish(server);

    const response = await server.inject({
      method: "PATCH",
      url: `/api/v1/entries/${entry.id}`,
      payload: { title: entry.title, markdown: "修改后的正文", tags: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      markdown: "修改后的正文",
      publishedAt: entry.publishedAt,
      edited: true,
    });
  });

  it("restores trashed entries before their retention period ends", async () => {
    const { server } = createServer();
    const entry = await publish(server);

    const deleted = await server.inject({ method: "DELETE", url: `/api/v1/entries/${entry.id}` });
    expect(deleted.statusCode).toBe(204);

    const restored = await server.inject({
      method: "POST",
      url: `/api/v1/trash/${entry.id}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      id: entry.id,
      state: "published",
      deletedAt: null,
      edited: false,
    });
  });

  it("purges an entry at the exact 30-day trash boundary", async () => {
    const { server, repository } = createServer();
    const entry = await publish(server);
    repository.trashPublished(entry.id, "2026-07-26T00:00:00.000+08:00");

    expect(purgeExpiredTrash(repository, new Date("2026-08-24T00:00:00.000+08:00"))).toBe(0);
    expect(purgeExpiredTrash(repository, new Date("2026-08-25T00:00:00.000+08:00"))).toBe(1);
  });
});
