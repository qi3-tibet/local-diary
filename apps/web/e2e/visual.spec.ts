import type { EntryMusic } from "@diary/contracts";
import { expect, test, type Page } from "@playwright/test";

const visualEntries = [
  entry(
    "10000000-0000-4000-8000-000000000001",
    "雨停之后",
    "2026-07-26T13:42:00.000Z",
    "雨停之后，窗台上的光慢慢移向书页。\n\n一小段安静的下午，被留在这里。",
    {
      mediaId: "20000000-0000-4000-8000-000000000001",
      title: "迟来的风",
      artist: "林间",
      album: "夏日留声",
      year: 2026,
      coverMediaId: null,
      coverMime: null,
      recognitionStatus: "manual" as const,
      originalFilename: "late-wind.mp3",
      streamUrl: "/api/v1/media/20000000-0000-4000-8000-000000000001/stream",
      coverUrl: null,
      available: true,
    },
  ),
  entry(
    "10000000-0000-4000-8000-000000000002",
    "夜间散步",
    "2026-07-26T10:08:00.000Z",
    "沿着旧街走了一圈。路面仍有雨水，灯影被拉得很长。",
  ),
  entry(
    "10000000-0000-4000-8000-000000000003",
    "周六",
    "2026-07-25T12:16:00.000Z",
    "午后读完一本薄薄的书，记下其中一段关于时间的话。",
  ),
];

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await page.route("**/api/v1/entries/days?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        days: [
          { day: "2026-07-26", totalEntries: 2, entries: visualEntries.slice(0, 2) },
          { day: "2026-07-25", totalEntries: 1, entries: visualEntries.slice(2) },
        ],
        previousCursor: null,
        nextCursor: null,
      }),
    });
  });
  await page.route("**/api/v1/draft", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
  });
});

test("Fine Scale light screen matches the approved baseline", async ({ page }) => {
  await setTheme(page, "light");
  await expect(page.locator("#day-2026-07-26")).toBeVisible();
  await expect(page).toHaveScreenshot("fine-scale-light.png", {
    animations: "disabled",
    fullPage: true,
  });
});

test("Fine Scale dark screen matches the approved baseline", async ({ page }) => {
  await setTheme(page, "dark");
  await expect(page.locator("#day-2026-07-26")).toBeVisible();
  await expect(page).toHaveScreenshot("fine-scale-dark.png", {
    animations: "disabled",
    fullPage: true,
  });
});

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem("diary-theme", value), theme);
  await page.goto("/?fixture=visual");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.evaluate(() => document.fonts.ready);
}

function entry(
  id: string,
  title: string,
  publishedAt: string,
  markdown: string,
  music: EntryMusic | null = null,
) {
  return {
    id,
    title,
    markdown,
    state: "published" as const,
    publishedAt,
    createdAt: publishedAt,
    updatedAt: publishedAt,
    deletedAt: null,
    edited: false,
    tags: [],
    music,
  };
}
