import { expect, test, type Locator, type Page } from "@playwright/test";

const portraitPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAAD0lEQVR42mNkYPj/H4QZAAq4A/2jR5nAAAAAAElFTkSuQmCC",
  "base64",
);
const landscapePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADUlEQVR42mNk+M/wHwAEAQH/CFvcWQAAAABJRU5ErkJggg==",
  "base64",
);

test("keeps two images at their authored body positions", async ({ page }) => {
  await openDraft(page, "Images", "First paragraph.\n\nSecond paragraph.");

  const body = page.getByLabel("Markdown body");
  await placeCursorAfter(body, "First paragraph.");
  await uploadImage(page, "portrait.png", portraitPng);
  await expect(body).toHaveValue(
    /First paragraph\.!\[portrait\.png\]\(media:[^)]+\)\n\nSecond paragraph\./,
    { timeout: 10_000 },
  );

  await placeCursorAfter(body, "Second paragraph.");
  await uploadImage(page, "landscape.png", landscapePng);
  await expect(body).toHaveValue(/First paragraph\.!\[portrait\.png\]\(media:[^)]+\)\n\nSecond paragraph\.!\[landscape\.png\]\(media:[^)]+\)/);

  await page.getByRole("button", { name: "Done" }).click();

  const images = page.locator(".entry-body img");
  await expect(images).toHaveCount(2);
  await expect(images.first()).toHaveAttribute("alt", "portrait.png");
  await expect(images.last()).toHaveAttribute("alt", "landscape.png");
  await expect(images.first()).toHaveAttribute("loading", "lazy");
  await expect(images.first()).toHaveAttribute("decoding", "async");
  await expect(images.first()).toHaveAttribute("src", /\/api\/v1\/media\/[^/]+\/display$/);
  await expect(images.first()).toBeVisible();
  await expect(images.last()).toBeVisible();
});

test("preserves writing added while an image is uploading", async ({ page }) => {
  await openDraft(page, "Slow image", "Opening paragraph.");
  const body = page.getByLabel("Markdown body");
  await placeCursorAfter(body, "Opening paragraph.");

  let releaseUpload!: () => void;
  let markUploadStarted!: () => void;
  const uploadReleased = new Promise<void>((resolve) => { releaseUpload = resolve; });
  const uploadStarted = new Promise<void>((resolve) => { markUploadStarted = resolve; });
  await page.route("**/api/v1/entries/*/images", async (route) => {
    markUploadStarted();
    await uploadReleased;
    await route.continue();
  });

  await uploadImage(page, "portrait.png", portraitPng);
  await uploadStarted;
  await body.press("End");
  await body.type("\n\nWritten during upload.");
  releaseUpload();

  await expect(body).toHaveValue(
    /Opening paragraph\.!\[portrait\.png\]\(media:[^)]+\)\n\nWritten during upload\./,
  );
  await expect(body).toBeFocused();
  await expect.poll(() => body.evaluate((node) => {
    const field = node as HTMLTextAreaElement;
    return field.selectionStart === field.value.length;
  })).toBe(true);
});

test("tracks edits before and replacing the upload selection", async ({ page }) => {
  await openDraft(page, "Tracked image", "Alpha Before replace me after Omega");
  const body = page.getByLabel("Markdown body");

  const firstUpload = await holdNextUpload(page);
  await placeCursorAfter(body, "Alpha");
  await uploadImage(page, "portrait.png", portraitPng);
  await firstUpload.started;
  await body.evaluate((node) => {
    const field = node as HTMLTextAreaElement;
    field.setSelectionRange(0, 0);
  });
  await body.type("Prefix ");
  firstUpload.release();
  await expect(body).toHaveValue(
    /Prefix Alpha!\[portrait\.png\]\(media:[^)]+\) Before replace me after Omega/,
  );

  const secondUpload = await holdNextUpload(page);
  await selectText(body, "replace me");
  await uploadImage(page, "landscape.png", landscapePng);
  await secondUpload.started;
  await selectText(body, "replace me");
  await body.type("kept note");
  await body.press("End");
  secondUpload.release();

  await expect(body).toHaveValue(
    /Before kept note!\[landscape\.png\]\(media:[^)]+\) after Omega/,
  );
  await expect(body).toBeFocused();
  await expect.poll(() => body.evaluate((node) => {
    const field = node as HTMLTextAreaElement;
    return field.selectionStart === field.value.length;
  })).toBe(true);
});

test("waits for a pending image before publishing", async ({ page }) => {
  await openDraft(page, "Wait for image", "Text stays with its image.");
  const body = page.getByLabel("Markdown body");
  const pendingUpload = await holdNextUpload(page);
  await placeCursorAfter(body, "image.");
  await uploadImage(page, "portrait.png", portraitPng);
  await pendingUpload.started;

  const done = page.getByRole("button", { name: "Done" });
  await done.click();
  await expect(done).toBeDisabled();
  await expect(page.getByLabel("Diary editor")).toBeVisible();

  pendingUpload.release();

  const published = page.getByRole("article").filter({ hasText: "Text stays with its image." });
  const image = published.locator(".entry-body img");
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("alt", "portrait.png");
  await expect(published.getByText("Text stays with its image.")).toBeVisible();
});

async function openDraft(page: Page, title: string, markdown: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New entry" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Markdown body").fill(markdown);
}

async function placeCursorAfter(textarea: Locator, marker: string): Promise<void> {
  await textarea.evaluate((node, value) => {
    const element = node as HTMLTextAreaElement;
    const cursor = element.value.indexOf(value) + value.length;
    element.focus();
    element.setSelectionRange(cursor, cursor);
  }, marker);
}

async function selectText(textarea: Locator, text: string): Promise<void> {
  await textarea.evaluate((node, value) => {
    const element = node as HTMLTextAreaElement;
    const start = element.value.indexOf(value);
    element.focus();
    element.setSelectionRange(start, start + value.length);
  }, text);
}

async function holdNextUpload(page: Page): Promise<{
  started: Promise<void>;
  release(): void;
}> {
  let release!: () => void;
  let markStarted!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  await page.route("**/api/v1/entries/*/images", async (route) => {
    markStarted();
    await released;
    await route.continue();
  }, { times: 1 });
  return { started, release };
}

async function uploadImage(page: Page, name: string, buffer: Buffer): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Insert image" }).click();
  await (await chooser).setFiles({ name, mimeType: "image/png", buffer });
}
