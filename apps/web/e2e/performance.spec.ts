import { expect, test, type Page } from "@playwright/test";

async function waitForScrollSettled(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    let previous = window.scrollY;
    let stableFrames = 0;
    const check = () => {
      const next = window.scrollY;
      stableFrames = Math.abs(next - previous) < 0.5 ? stableFrames + 1 : 0;
      previous = next;
      if (stableFrames >= 4) resolve();
      else window.requestAnimationFrame(check);
    };
    window.requestAnimationFrame(check);
  }));
}

async function waitForWindowSettled(page: Page) {
  return page.evaluate(() => new Promise<string[]>((resolve) => {
    const read = () => [...document.querySelectorAll<HTMLElement>("section[data-day]")].map((node) => node.id);
    let previous = read().join("|");
    let stableFrames = 0;
    const check = () => {
      const ids = read();
      const next = ids.join("|");
      stableFrames = next === previous ? stableFrames + 1 : 0;
      previous = next;
      if (stableFrames >= 4) resolve(ids);
      else window.requestAnimationFrame(check);
    };
    window.requestAnimationFrame(check);
  }));
}

async function enteredSectionInViewport(page: Page, prior: string[], next: string[], side: "top" | "bottom") {
  const entered = next.filter((id) => !prior.includes(id));
  let visibleId = await page.evaluate((ids) => ids.find((id) => {
    const bounds = document.getElementById(id)?.getBoundingClientRect();
    return bounds && bounds.bottom > 0 && bounds.top < window.innerHeight;
  }), entered);
  if (!visibleId) {
    visibleId = side === "bottom" ? entered[0] : entered.at(-1);
    await page.evaluate((id) => {
      const root = document.documentElement;
      root.style.scrollBehavior = "auto";
      document.getElementById(id!)?.scrollIntoView({ block: "center" });
    }, visibleId);
    await waitForScrollSettled(page);
  }
  expect(visibleId).toBeTruthy();
  return page.locator(`#${visibleId}`);
}

async function enterSentinel(page: Page, testId: "top-window-sentinel" | "bottom-window-sentinel") {
  await waitForScrollSettled(page);
  await page.evaluate((id) => {
    const root = document.documentElement;
    const scrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    const sentinel = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    const offset = id === "bottom-window-sentinel" ? window.innerHeight - 120 : 120;
    window.scrollTo(0, Math.max(0, window.scrollY + sentinel.getBoundingClientRect().top - offset));
    root.style.scrollBehavior = scrollBehavior;
  }, testId);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("jumps from the rail without mounting 20,000 entry nodes", async ({ page, request }) => {
  const fixture = await request.post("http://127.0.0.1:4174/__e2e__/large-fixture", {
    headers: { "x-diary-e2e-token": process.env.DIARY_E2E_RUN_ID ?? "" },
  });
  expect(fixture.ok()).toBeTruthy();
  await page.goto("/?fixture=large");
  await page.getByLabel("Jump to date").fill("2020-07-26");
  await page.getByRole("button", { name: "Go to July 26, 2020" }).click();
  await expect(page.locator("#day-2020-07-26")).toBeInViewport();
  await waitForScrollSettled(page);
  expect(await page.locator("article.entry").count()).toBeLessThan(250);

  await page.getByLabel("Jump to date").fill("2025-07-26");
  await page.getByRole("button", { name: "Go to July 26, 2025" }).click();
  await expect(page.locator("#day-2025-07-26")).toBeInViewport();
  await waitForScrollSettled(page);

  const visibleWindows = new Set<string>();
  const firstWindow = await page.locator("section[data-day]").evaluateAll((nodes) => nodes.map((node) => node.id));
  let olderDistance = 0;
  for (let index = 0; index < 20 && olderDistance <= 60; index += 1) {
    const prior = await page.locator("section[data-day]").evaluateAll((nodes) => nodes.map((node) => node.id));
    await enterSentinel(page, "bottom-window-sentinel");
    await expect.poll(async () => page.locator("section[data-day]").evaluateAll((nodes) => nodes.map((node) => node.id).join("|"))).not.toBe(prior.join("|"));
    const next = await waitForWindowSettled(page);
    const enteredSection = await enteredSectionInViewport(page, prior, next, "bottom");
    await expect(enteredSection).toBeInViewport();
    await expect(enteredSection.locator("article.entry").first()).toContainText(/日常记录|水滴/);
    const visible = next.join("|");
    visibleWindows.add(visible);
    olderDistance = (
      Date.parse(firstWindow[0]!.slice("day-".length))
      - Date.parse(next[0]!.slice("day-".length))
    ) / 86_400_000;
  }
  expect(olderDistance).toBeGreaterThan(60);
  const idsAfterOlder = await page.locator("section[data-day]").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(idsAfterOlder).size).toBe(idsAfterOlder.length);
  expect(await page.locator("article.entry").count()).toBeLessThan(250);
  for (let index = 0; index < 20; index += 1) {
    const prior = await page.locator("section[data-day]").evaluateAll((nodes) => nodes.map((node) => node.id));
    if (prior.join("|") === firstWindow.join("|")) break;
    await enterSentinel(page, "top-window-sentinel");
    await expect.poll(async () => page.locator("section[data-day]").evaluateAll((nodes) => nodes.map((node) => node.id).join("|"))).not.toBe(prior.join("|"));
    const next = await waitForWindowSettled(page);
    if (next.join("|") === firstWindow.join("|")) {
      visibleWindows.add(next.join("|"));
      break;
    }
    const enteredSection = await enteredSectionInViewport(page, prior, next, "top");
    await expect(enteredSection).toBeInViewport();
    await expect(enteredSection.locator("article.entry").first()).toContainText(/日常记录|水滴/);
    const visible = next.join("|");
    visibleWindows.add(visible);
  }
  const idsAfterNewer = await page.locator("section[data-day]").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(idsAfterNewer).size).toBe(idsAfterNewer.length);
  expect(idsAfterNewer).toEqual(firstWindow);
  expect(await page.locator("article.entry").count()).toBeLessThan(250);
  expect(visibleWindows.size).toBeGreaterThanOrEqual(3);
});

test("preserves a visible day while a preceding mounted entry grows", async ({ page, request }) => {
  const fixture = await request.post("http://127.0.0.1:4174/__e2e__/large-fixture", {
    headers: { "x-diary-e2e-token": process.env.DIARY_E2E_RUN_ID ?? "" },
  });
  expect(fixture.ok()).toBeTruthy();
  await page.goto("/?fixture=large");
  await page.getByLabel("Jump to date").fill("2025-07-26");
  await page.getByRole("button", { name: "Go to July 26, 2025" }).click();
  await expect(page.locator("#day-2025-07-26")).toBeInViewport();
  await waitForScrollSettled(page);
  const anchor = page.locator("section[data-day]").nth(7);
  await anchor.evaluate((section) => {
    const root = document.documentElement;
    root.style.scrollBehavior = "auto";
    section.scrollIntoView({ block: "start" });
  });
  await waitForScrollSettled(page);
  await expect(anchor).toBeInViewport();
  const anchorTop = (await anchor.boundingBox())!.y;
  await page.locator("section[data-day]").nth(1).locator(".entry-body").first().evaluate((body) => {
    (body as HTMLElement).style.minHeight = "900px";
  });
  await expect.poll(async () => Math.abs(((await anchor.boundingBox())?.y ?? 0) - anchorTop)).toBeLessThanOrEqual(8);
});
