import { expect, test } from "@playwright/test";

test("does not create a recovery draft when a new editor is left untouched", async ({ page }) => {
  let draftWrites = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PUT"
      && request.url().endsWith("/api/v1/draft")
    ) {
      draftWrites += 1;
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: "New entry" }).click();
  await expect(page.getByLabel("Title")).toBeFocused();
  await page.waitForTimeout(700);
  expect(draftWrites).toBe(0);

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "NEW ENTRY" })).not.toBeAttached();
  expect(draftWrites).toBe(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "NEW ENTRY" })).not.toBeAttached();
});
