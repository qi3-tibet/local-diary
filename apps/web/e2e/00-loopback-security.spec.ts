import { expect, test } from "@playwright/test";

test("does not let the development proxy launder a hostile Origin", async ({ request }) => {
  const read = await request.get("/api/v1/entries", {
    headers: { Origin: "https://evil.example" },
  });
  const mutation = await request.put("/api/v1/draft", {
    headers: { Origin: "https://evil.example" },
    data: {
      title: "hostile",
      markdown: "must not persist",
      tags: [],
    },
  });
  const draft = await request.get("/api/v1/draft");

  expect(read.status()).toBe(403);
  expect(mutation.status()).toBe(403);
  expect(await draft.json()).toBeNull();
});
