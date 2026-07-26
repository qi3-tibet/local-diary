import { expect, test } from "@playwright/test";

test("first browser launch stays loopback-only and reuses existing diary data", async ({ page, request }) => {
  const origins = new Set<string>();
  page.on("request", (request) => origins.add(new URL(request.url()).origin));

  const draft = await request.put("http://127.0.0.1:4174/api/v1/draft", {
    data: {
      title: "Release data reuse",
      markdown: "Data written on first launch remains on the next launch.",
      tags: ["release-flow"],
    },
  });
  expect(draft.ok()).toBe(true);
  const published = await request.post("http://127.0.0.1:4174/api/v1/draft/publish");
  expect(published.ok()).toBe(true);
  const publishedEntry = await published.json() as { publishedAt: string };
  const day = beijingDay(publishedEntry.publishedAt);

  await page.goto(`/?day=${day}`);
  await expect(page.getByText("Data written on first launch remains on the next launch.")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Data written on first launch remains on the next launch.")).toBeVisible();
  expect([...origins].every((origin) => (
    origin === "http://127.0.0.1:4173" || origin === "http://127.0.0.1:4174"
  ))).toBe(true);
});

function beijingDay(timestamp: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find((part) => part.type === type)?.value ?? ""
  );
  return `${value("year")}-${value("month")}-${value("day")}`;
}
