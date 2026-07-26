import { expect, test } from "@playwright/test";

const tinyMp3 = Buffer.from(
  "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAwAAAAAAAAAAAAAAD/4zjAAAAAAAAAAAAASW5mbwAAAA8AAAAAAAAA2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAAAAAAAAAAAAAANgAAPVdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "base64",
);

test("continues one global player across day scrolling, theme changes, and narrow layouts", async ({ page, request }) => {
  const seeded = await request.post("http://127.0.0.1:4174/__e2e__/music-fixture");
  expect(seeded.ok()).toBe(true);
  const fixture = await seeded.json() as { mediaId: string; streamUrl: string };

  const complete = await request.get(`http://127.0.0.1:4174${fixture.streamUrl}`);
  expect(complete.status()).toBe(200);
  expect(complete.headers()["accept-ranges"]).toBe("bytes");
  expect(Number(complete.headers()["content-length"])).toBeGreaterThan(0);

  const ranged = await request.get(`http://127.0.0.1:4174${fixture.streamUrl}`, {
    headers: { range: "bytes=0-9" },
  });
  expect(ranged.status()).toBe(206);
  expect(ranged.headers()["content-range"]).toMatch(/^bytes 0-9\/\d+$/);
  expect((await ranged.body())).toHaveLength(10);

  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    (window as unknown as { __audioOwners: number }).__audioOwners = 0;
    window.Audio = function Audio(...args: ConstructorParameters<typeof NativeAudio>) {
      (window as unknown as { __audioOwners: number }).__audioOwners += 1;
      return new NativeAudio(...args);
    } as typeof Audio;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Play Pink + White" }).click();
  await expect(page.getByRole("region", { name: "Now playing" })).toContainText("Pink + White");
  expect(await page.evaluate(() => (window as unknown as { __audioOwners: number }).__audioOwners))
    .toBe(1);

  await page.locator("#day-2026-07-25").scrollIntoViewIfNeeded();
  await expect(page.getByRole("region", { name: "Now playing" })).toContainText("Pink + White");

  await page.getByRole("button", { name: /Theme:/ }).click();
  await expect(page.getByRole("region", { name: "Now playing" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 760 });
  await expect(page.getByRole("region", { name: "Now playing" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Playback position" })).toBeVisible();
});

test("attaches a valid local MP3 and corrects its metadata without external recognition", async ({ page }) => {
  await page.route("**/api/v1/entries/*/music/recognition", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mediaId: "00000000-0000-4000-8000-000000000001",
        title: null,
        artist: null,
        album: null,
        year: null,
        coverMediaId: null,
        recognitionStatus: "manual_required",
        candidates: [],
        selectedCandidateId: null,
      }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "New entry" }).click();
  await page.getByLabel("Title").fill("Music upload");
  await page.getByLabel("Markdown body").fill("窗外的路灯刚刚亮起。");

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach MP3" }).click();
  await (await chooser).setFiles({ name: "night.mp3", mimeType: "audio/mpeg", buffer: tinyMp3 });

  const metadata = page.getByRole("region", { name: "Music metadata" });
  await expect(metadata).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Song title" })).toHaveCSS(
    "font-family",
    /Noto Serif SC/u,
  );
  await expect(page.getByRole("textbox", { name: "Artist" })).toHaveCSS(
    "font-family",
    /Noto Serif SC/u,
  );
  await expect(page.getByRole("textbox", { name: "Album" })).toHaveCSS(
    "font-family",
    /Noto Serif SC/u,
  );
  await page.getByRole("textbox", { name: "Song title" }).fill("夜航");
  await page.getByRole("textbox", { name: "Artist" }).fill("某人");
  await page.getByRole("textbox", { name: "Album" }).fill("窗边");
  await page.getByRole("button", { name: "Save music metadata" }).click();
  await page.getByRole("button", { name: "Done" }).click();

  const entry = page.getByRole("article").filter({ hasText: "窗外的路灯刚刚亮起。" });
  await expect(entry).toContainText("夜航");
  await expect(entry).toContainText("某人 · 窗边");
  await expect(entry.getByRole("button", { name: "Play 夜航" })).toBeVisible();
});

test("keeps the diary body readable when its stored MP3 is corrupt", async ({ page, request }) => {
  const seeded = await request.post("http://127.0.0.1:4174/__e2e__/music-fixture", {
    data: { corrupt: true },
  });
  expect(seeded.ok()).toBe(true);

  await page.goto("/");
  const entry = page.getByRole("article").filter({ hasText: "咖啡比往常更苦" });
  await expect(entry).toContainText("咖啡比往常更苦");
  await expect(entry.getByText("MEDIA UNAVAILABLE")).toBeVisible();
});
