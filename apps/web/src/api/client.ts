import type { Entry } from "@diary/contracts";

type Request = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createApiClient(request: Request = fetch) {
  return {
    async listEntries(): Promise<Entry[]> {
      const response = await request("/api/v1/entries", {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Could not load diary entries (${response.status}).`);
      }

      return (await response.json()) as Entry[];
    },
  };
}

export const api = createApiClient();
