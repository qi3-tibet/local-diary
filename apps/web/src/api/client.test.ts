import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";

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
});
