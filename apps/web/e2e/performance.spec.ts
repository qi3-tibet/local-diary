import { expect, test } from "@playwright/test";

test("jumps from the rail without mounting 20,000 entry nodes", async ({ page, request }) => {
  const fixture = await request.post("http://127.0.0.1:4174/__e2e__/large-fixture", {
    headers: { "x-diary-e2e-token": process.env.DIARY_E2E_RUN_ID ?? "" },
  });
  expect(fixture.ok()).toBeTruthy();
  await page.goto("/?fixture=large");
  await page.getByLabel("Jump to date").fill("2020-07-26");
  await page.getByRole("button", { name: "Go to July 26, 2020" }).click();
  await expect(page.locator("#day-2020-07-26")).toBeInViewport();
  expect(await page.locator("article.entry").count()).toBeLessThan(250);

  await page.getByLabel("Jump to date").fill("2025-07-26");
  await page.getByRole("button", { name: "Go to July 26, 2025" }).click();
  await expect(page.locator("#day-2025-07-26")).toBeInViewport();

  const visibleWindows = new Set<string>();
  for (let index = 0; index < 3; index += 1) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    const visible = await page.locator("section[data-day]").evaluateAll((nodes) => nodes.map((node) => node.id).join("|"));
    visibleWindows.add(visible);
    await expect(page.locator("article.entry").first()).toBeVisible();
  }
  const idsAfterOlder = await page.locator("section[data-day]").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(idsAfterOlder).size).toBe(idsAfterOlder.length);
  expect(await page.locator("article.entry").count()).toBeLessThan(250);
  for (let index = 0; index < 3; index += 1) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const visible = await page.locator("section[data-day]").evaluateAll((nodes) => nodes.map((node) => node.id).join("|"));
    visibleWindows.add(visible);
    await expect(page.locator("article.entry").first()).toBeVisible();
  }
  const idsAfterNewer = await page.locator("section[data-day]").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(idsAfterNewer).size).toBe(idsAfterNewer.length);
  expect(await page.locator("article.entry").count()).toBeLessThan(250);
  expect(visibleWindows.size).toBeGreaterThanOrEqual(3);
});
