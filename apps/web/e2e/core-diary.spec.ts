import { expect, test } from "@playwright/test";

test("drafts, publishes, searches, edits, trashes, and restores", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New entry" }).click();
  await page.getByLabel("Title").fill("雨后的街道");
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT"
      && response.url().endsWith("/api/v1/draft")
      && response.ok(),
  );
  await page.getByLabel("Markdown body").fill("空气变凉了。");
  await saved;

  await page.reload();
  await expect(page.getByLabel("Markdown body")).toHaveValue("空气变凉了。");
  await page.getByRole("button", { name: "Toggle preview" }).click();
  await expect(page.getByText("空气变凉了。")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  await expect(page.getByText("空气变凉了。")).toBeVisible();
  await expect(page.getByText("雨后的街道")).not.toBeVisible();

  await page.getByRole("article").hover();
  await page.getByRole("button", { name: "Edit entry" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("雨后的街道");
  await page.getByLabel("Markdown body").fill("空气变得更凉了。");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("空气变得更凉了。")).toBeVisible();
  await expect(page.getByText("雨后的街道")).not.toBeVisible();

  await page.getByRole("button", { name: "Search" }).click();
  await page.getByLabel("Search diary").fill("雨后");
  const searchResult = page.getByRole("listitem").filter({ hasText: "雨后的街道" });
  await expect(searchResult).toBeVisible();
  await expect(searchResult.getByText("EDITED")).toBeVisible();
  await searchResult.getByRole("button", { name: "Move to trash" }).click();
  await expect(searchResult).not.toBeVisible();

  await page.getByRole("button", { name: "Trash" }).click();
  const trashItem = page.getByRole("listitem").filter({ hasText: "雨后的街道" });
  await expect(trashItem).toBeVisible();
  await trashItem.getByRole("button", { name: "Restore entry" }).click();
  await expect(trashItem).not.toBeVisible();

  await page.getByRole("button", { name: "Diary" }).click();
  await expect(page.getByText("空气变得更凉了。")).toBeVisible();
  await expect(page.getByText("雨后的街道")).not.toBeVisible();
});
