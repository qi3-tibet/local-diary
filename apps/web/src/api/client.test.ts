import type { DraftInput, Entry } from "@diary/contracts";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";

type RequestFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const input: DraftInput = {
  title: "雨后的街道",
  markdown: "空气变凉了。",
  tags: [],
};

const entry = {
  id: "entry-1",
  ...input,
  state: "published",
} as Entry;

describe("diary API client", () => {
  it("returns the published entry array without adapting its shape", async () => {
    const entries = [{ id: "entry-1", title: "Kept by the contract" }];
    const request = vi.fn(async () => new Response(JSON.stringify(entries), { status: 200 }));
    const client = createApiClient(request);

    await expect(client.listEntries()).resolves.toEqual(entries);
    expect(request).toHaveBeenCalledWith("/api/v1/entries", {
      headers: { accept: "application/json" },
    });
  });

  it("rejects a failed list request with an English error", async () => {
    const client = createApiClient(async () => new Response(null, { status: 503 }));

    await expect(client.listEntries()).rejects.toThrow("Could not load diary entries (503).");
  });

  it("loads and saves the single draft", async () => {
    const request = vi
      .fn<RequestFn>()
      .mockResolvedValueOnce(new Response(JSON.stringify(entry), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(entry), { status: 200 }));
    const client = createApiClient(request);

    await expect(client.getDraft()).resolves.toEqual(entry);
    await expect(client.saveDraft(input)).resolves.toEqual(entry);
    expect(request).toHaveBeenNthCalledWith(1, "/api/v1/draft", {
      headers: { accept: "application/json" },
    });
    expect(request).toHaveBeenNthCalledWith(2, "/api/v1/draft", {
      method: "PUT",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
  });

  it("publishes and edits through their entry routes", async () => {
    const request = vi
      .fn<RequestFn>()
      .mockResolvedValueOnce(new Response(JSON.stringify(entry), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(entry), { status: 200 }));
    const client = createApiClient(request);

    await expect(client.publishDraft()).resolves.toEqual(entry);
    await expect(client.updateEntry(entry.id, input)).resolves.toEqual(entry);
    expect(request).toHaveBeenNthCalledWith(1, "/api/v1/draft/publish", {
      method: "POST",
      headers: { accept: "application/json" },
    });
    expect(request).toHaveBeenNthCalledWith(2, `/api/v1/entries/${entry.id}`, {
      method: "PATCH",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
  });

  it("searches, trashes, lists trash, and restores entries", async () => {
    const request = vi
      .fn<RequestFn>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [entry] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [entry] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(entry), { status: 200 }));
    const client = createApiClient(request);

    await expect(client.searchEntries("雨 后")).resolves.toEqual([entry]);
    await expect(client.trashEntry(entry.id)).resolves.toBeUndefined();
    await expect(client.listTrash()).resolves.toEqual([entry]);
    await expect(client.restoreEntry(entry.id)).resolves.toEqual(entry);
    expect(request).toHaveBeenNthCalledWith(
      1,
      `/api/v1/search?q=${encodeURIComponent("雨 后")}`,
      { headers: { accept: "application/json" } },
    );
    expect(request).toHaveBeenNthCalledWith(2, `/api/v1/entries/${entry.id}`, {
      method: "DELETE",
    });
    expect(request).toHaveBeenNthCalledWith(3, "/api/v1/trash", {
      headers: { accept: "application/json" },
    });
    expect(request).toHaveBeenNthCalledWith(4, `/api/v1/trash/${entry.id}/restore`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
  });

  it("uploads an image for an entry and exposes its stable display URL", async () => {
    const uploaded = {
      mediaId: "image-1",
      markdownUrl: "media:image-1",
      alt: "portrait.png",
      derivativeStatus: "ready",
    };
    const request = vi.fn<RequestFn>(async () =>
      new Response(JSON.stringify(uploaded), { status: 201 }),
    );
    const client = createApiClient(request);
    const image = new File(["image bytes"], "portrait.png", { type: "image/png" });

    await expect(client.uploadImage("entry-1", image)).resolves.toEqual(uploaded);
    expect(request).toHaveBeenCalledOnce();
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe("/api/v1/entries/entry-1/images");
    expect(init).toMatchObject({ method: "POST" });
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("image")).toBe(image);
    expect(client.mediaDisplayUrl("image / 1")).toBe(
      "/api/v1/media/image%20%2F%201/display",
    );
  });
});
