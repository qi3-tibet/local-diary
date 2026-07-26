import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const themeLabels = {
  system: "Theme: System. Switch to light theme",
  light: "Theme: Light. Switch to dark theme",
  dark: "Theme: Dark. Follow system theme",
} as const;

test("has no accessibility violations in light and dark themes", async ({ page }) => {
  for (const theme of ["light", "dark"] as const) {
    await page.addInitScript((preference) => {
      window.localStorage.setItem("diary-theme", preference);
    }, theme);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expectNoAxeViolations(page);

    await page.getByRole("button", { name: "New entry" }).click();
    await expect(page.getByRole("heading", { name: "NEW ENTRY" })).toBeAttached();
    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("heading", { name: "SEARCH" })).toBeVisible();
    await expectNoAxeViolations(page);

    await page.getByRole("button", { name: "Trash" }).click();
    await expect(page.getByRole("heading", { name: /TRASH/ })).toBeVisible();
    await expectNoAxeViolations(page);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "BACKUP" })).toBeVisible();
    await expectNoAxeViolations(page);
  }
});

test("supports the main writing flow with only the keyboard", async ({ page }) => {
  await page.goto("/");
  await activateWithKeyboard(page, page.getByRole("button", { name: "New entry" }));

  const title = page.getByLabel("Title");
  await expect(title).toBeFocused();
  await page.keyboard.type("Keyboard entry");
  await activateWithKeyboard(page, page.getByRole("textbox", { name: "Markdown body" }));
  await page.keyboard.type("Written without a pointer.");

  await activateWithKeyboard(page, page.getByRole("button", { name: "Toggle preview" }));
  await expect(page.getByLabel("Markdown preview")).toContainText("Written without a pointer.");
  await activateWithKeyboard(page, page.getByRole("button", { name: "Done" }));
  await expect(page.getByText("Written without a pointer.")).toBeVisible();

  await activateWithKeyboard(page, page.getByRole("button", { name: "Search" }));
  const search = page.getByLabel("Search diary");
  await expect(search).toBeFocused();
  await page.keyboard.type("Keyboard entry");
  const result = page.getByRole("listitem").filter({ hasText: "Keyboard entry" });
  await expect(result.getByRole("button", { name: "Keyboard entry" })).toBeVisible();
  await activateWithKeyboard(page, result.getByRole("button", { name: "Move to trash" }));
  await expect(result).not.toBeVisible();
});

test("cycles system, light, and dark without text and respects operating-system changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");

  const theme = page.getByRole("button", { name: themeLabels.system });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(theme).toBeEmpty();
  const target = await theme.boundingBox();
  expect(target?.width).toBeGreaterThanOrEqual(40);
  expect(target?.height).toBeGreaterThanOrEqual(40);
  await expect(page.locator("html")).toHaveCSS("scroll-behavior", "auto");

  await theme.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await activateWithKeyboard(page, page.getByRole("button", { name: themeLabels.light }));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await activateWithKeyboard(page, page.getByRole("button", { name: themeLabels.dark }));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("keeps controls and content inside 320, 400, and 768 pixel viewports", async ({ page }) => {
  await page.goto("/");
  for (const width of [320, 400, 768]) {
    await page.setViewportSize({ width, height: 720 });
    await expect.poll(() => page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }))).toEqual({ client: width, scroll: width });
  }

  await activateWithKeyboard(page, page.getByRole("button", { name: "New entry" }));
  for (const width of [320, 400, 768]) {
    await page.setViewportSize({ width, height: 720 });
    await expect.poll(() => page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }))).toEqual({ client: width, scroll: width });
  }
  for (const name of ["Insert image", "Attach MP3", "Toggle preview"]) {
    const control = page.getByRole("button", { name });
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(40);
    expect(box?.height).toBeGreaterThanOrEqual(40);
  }
});

test("keeps Georgia on interface copy and Noto Serif SC on approved content", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "New entry" })).toHaveCSS("font-family", /Georgia/u);
  await expect(page.locator(".date-rail")).toHaveCSS("font-family", /Georgia/u);
  await page.getByRole("button", { name: "New entry" }).click();
  await expect(page.locator(".editor-title-field")).toHaveCSS("font-family", /Georgia/u);
  await expect(page.getByLabel("Title")).toHaveCSS("font-family", /Noto Serif SC/u);
  await expect(page.getByLabel("Markdown body")).toHaveCSS("font-family", /Noto Serif SC/u);

  await page.getByLabel("Title").fill("字体边界");
  await page.getByLabel("Markdown body").fill("只让内容使用中文衬线。");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("只让内容使用中文衬线。")).toHaveCSS(
    "font-family",
    /Noto Serif SC/u,
  );
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByLabel("Search diary").fill("字体边界");
  const result = page.getByRole("listitem").filter({ hasText: "字体边界" });
  await expect(result.getByRole("button", { name: "字体边界" })).toHaveCSS(
    "font-family",
    /Noto Serif SC/u,
  );
  await result.getByRole("button", { name: "Move to trash" }).click();
  await expect(result).not.toBeVisible();
});

async function activateWithKeyboard(page: Page, locator: ReturnType<Page["locator"]>) {
  await locator.focus();
  await page.keyboard.press("Enter");
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, formatViolations(results.violations)).toEqual([]);
}

function formatViolations(violations: Array<{
  id: string;
  help: string;
  nodes: Array<{ target: unknown; failureSummary?: string }>;
}>): string {
  return violations.map((violation) => [
    `${violation.id}: ${violation.help}`,
    ...violation.nodes.map((node) => `  ${String(node.target)} ${node.failureSummary ?? ""}`),
  ].join("\n")).join("\n\n");
}
