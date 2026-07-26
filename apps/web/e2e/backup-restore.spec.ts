import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

test.describe.serial("backup and recovery", () => {
  test("downloads a complete archive, changes data, and restores every streamed phase", async ({ page }) => {
    await publish(page, "Recovery fixture", "Original body for recovery.");
    await page.getByRole("button", { name: "Settings" }).click();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export complete archive" }).click();
    const download = await downloadPromise;
    const archivePath = path.join(requiredRunRoot(), "complete-archive.zip");
    await download.saveAs(archivePath);

    await page.getByRole("button", { name: "Diary" }).click();
    const article = page.getByRole("article").filter({ hasText: "Original body for recovery." });
    await article.hover();
    await article.getByRole("button", { name: "Edit entry" }).click();
    await page.getByLabel("Markdown body").fill("Changed body after archive.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Changed body after archive.")).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Restore complete archive").setInputFiles(archivePath);
    const progress = page.getByLabel("Restore progress");
    await expect(progress.getByText("DONE", { exact: true })).toBeVisible();
    await expect(progress.locator("li")).toHaveText([
      "VALIDATING",
      "SAFETY_BACKUP",
      "RESTORING",
      "REBUILDING",
      "DONE",
    ]);
    await expect(page.getByText("Original body for recovery.")).toBeVisible();
    await expect(page.getByText("Changed body after archive.")).not.toBeVisible();
  });

  test("keeps a browser-picked folder client-side and never sends a server path", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "showDirectoryPicker", {
        configurable: true,
        value: async () => ({
          kind: "directory",
          name: "Browser vault",
          queryPermission: async () => "granted",
          requestPermission: async () => "granted",
          getFileHandle: async () => {
            throw new Error("not used in this test");
          },
        }),
      });
    });
    let backupPuts = 0;
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().endsWith("/api/v1/settings/backup")) {
        backupPuts += 1;
      }
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Choose backup location" }).click();

    await expect(page.getByText("BROWSER EXPORT FOLDER · Browser vault")).toBeVisible();
    await expect(page.getByText(/BROWSER EXPORT FOLDER READY/)).toBeVisible();
    expect(backupPuts).toBe(0);
  });

  test("persists only a desktop-bridge path and keeps an unwritable warning nonblocking", async ({ page }) => {
    const runRoot = requiredRunRoot();
    const verified = path.join(runRoot, "chosen-backups");
    const notDirectory = path.join(runRoot, "not-a-directory");
    await mkdir(runRoot, { recursive: true });
    await writeFile(notDirectory, "not writable as a directory");
    await page.addInitScript((chosen) => {
      Object.defineProperty(window, "diaryDesktop", {
        configurable: true,
        value: { chooseBackupDirectory: async () => chosen },
      });
    }, verified);

    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    const verifiedPut = page.waitForRequest((request) => (
      request.method() === "PUT"
      && request.url().endsWith("/api/v1/settings/backup")
      && request.postDataJSON().backupRoot === verified
    ));
    await page.getByRole("button", { name: "Choose backup location" }).click();
    await verifiedPut;
    await expect(page.getByText("BACKUP LOCATION VERIFIED")).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByLabel("Automatic backup location")).toHaveText(path.resolve(verified));

    await page.evaluate((chosen) => {
      Object.defineProperty(window, "diaryDesktop", {
        configurable: true,
        value: { chooseBackupDirectory: async () => chosen },
      });
    }, notDirectory);
    await page.getByRole("button", { name: "Choose backup location" }).click();
    await expect(page.getByText("BACKUP LOCATION IS NOT WRITABLE")).toBeVisible();
    await expect(page.getByRole("button", { name: "CHOOSE ANOTHER LOCATION" })).toBeVisible();

    await page.getByRole("button", { name: "New entry" }).click();
    await expect(page.getByLabel("Markdown body")).toBeEditable();
    await expect(page.getByText("BACKUP LOCATION IS NOT WRITABLE")).toBeVisible();
    await expect(page.getByRole("button", { name: "CHOOSE ANOTHER LOCATION" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  test("shows FAILED for a corrupt archive, retries, and does not mutate diary data", async ({ page }) => {
    const corrupt = path.join(requiredRunRoot(), "corrupt.zip");
    await writeFile(corrupt, "not a zip archive");
    await page.goto("/");
    await expect(page.getByText("Original body for recovery.")).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();

    await page.getByLabel("Restore complete archive").setInputFiles(corrupt);
    const progress = page.getByLabel("Restore progress");
    await expect(progress.getByText("FAILED", { exact: true })).toBeVisible();
    await progress.getByRole("button", { name: "Retry" }).click();
    await expect(progress.getByText("FAILED", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Diary" }).click();
    await expect(page.getByText("Original body for recovery.")).toBeVisible();
  });

  test("creates a manual snapshot and downloads portable Markdown", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();

    await page.getByRole("button", { name: "Create snapshot" }).click();
    await expect(page.getByText("SNAPSHOT COMPLETE")).toBeVisible();

    const markdownDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export portable Markdown" }).click();
    const download = await markdownDownload;
    expect(download.suggestedFilename()).toMatch(/^diary-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.zip$/);

    await page.getByRole("button", { name: "Diary" }).click();
    const fixture = page.getByRole("article").filter({ hasText: "Original body for recovery." });
    await fixture.hover();
    await fixture.getByRole("button", { name: "Move to trash" }).click();
    await expect(fixture).not.toBeVisible();
  });
});

async function publish(page: import("@playwright/test").Page, title: string, body: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New entry" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Markdown body").fill(body);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("article").filter({ hasText: body })).toBeVisible();
}

function requiredRunRoot(): string {
  const root = process.env.DIARY_E2E_RUN_ROOT;
  if (!root) throw new Error("DIARY_E2E_RUN_ROOT is required");
  return root;
}
