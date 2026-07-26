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

async function waitForEntryWindowSettled(page: Page) {
  return page.evaluate(() => new Promise<string[]>((resolve) => {
    const read = () => [...document.querySelectorAll<HTMLElement>("article.entry")]
      .map((node) => node.dataset.entryId!);
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
  const scrollBehavior = await page.evaluate((id) => {
    const root = document.documentElement;
    const scrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    const sentinel = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    const bounds = sentinel.getBoundingClientRect();
    const away = id === "top-window-sentinel"
      ? bounds.bottom < -500 ? window.scrollY + 1 : window.scrollY + 1_000
      : bounds.top > window.innerHeight + 500 ? window.scrollY - 1 : window.scrollY - 1_000;
    window.scrollTo(0, Math.max(0, away));
    return scrollBehavior;
  }, testId);
  await waitForSentinelSettled(page, testId);
  await page.evaluate((id) => {
    const sentinel = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    const offset = id === "bottom-window-sentinel" ? window.innerHeight - 120 : 120;
    window.scrollTo(0, Math.max(0, window.scrollY + sentinel.getBoundingClientRect().top - offset));
  }, testId);
  await waitForSentinelSettled(page, testId);
  await page.evaluate((previous) => {
    document.documentElement.style.scrollBehavior = previous;
  }, scrollBehavior);
}

async function waitForSentinelSettled(
  page: Page,
  testId: "top-window-sentinel" | "bottom-window-sentinel",
) {
  await page.evaluate((id) => new Promise<void>((resolve) => {
    const sentinel = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    let previousScrollY = window.scrollY;
    let previousTop = sentinel.getBoundingClientRect().top;
    let stableFrames = 0;
    const check = () => {
      const nextScrollY = window.scrollY;
      const nextTop = sentinel.getBoundingClientRect().top;
      stableFrames = Math.abs(nextScrollY - previousScrollY) < 0.5
        && Math.abs(nextTop - previousTop) < 0.5
        ? stableFrames + 1
        : 0;
      previousScrollY = nextScrollY;
      previousTop = nextTop;
      if (stableFrames >= 4) resolve();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }), testId);
}

test("jumps from the rail without mounting 20,000 entry nodes", async ({ page, request }) => {
  const fixture = await request.post("http://127.0.0.1:4174/__e2e__/large-fixture", {
    headers: { "x-diary-e2e-token": process.env.DIARY_E2E_RUN_ID ?? "" },
  });
  expect(fixture.ok()).toBeTruthy();
  await page.goto("/?fixture=large");
  await page.getByLabel("Jump to date").fill("2020-07-26");
  await page.getByRole("button", { name: "Go to July 26, 2020" }).click();
  await expect(page.locator("#day-2020-07-26")).toBeAttached();
  await waitForScrollSettled(page);
  await expect(page.locator("#day-2020-07-26")).toBeInViewport();
  expect(await page.locator("article.entry").count()).toBeLessThan(250);

  await page.getByLabel("Jump to date").fill("2025-07-26");
  await page.getByRole("button", { name: "Go to July 26, 2025" }).click();
  await expect(page.locator("#day-2025-07-26")).toBeAttached();
  await waitForScrollSettled(page);
  await expect(page.locator("#day-2025-07-26")).toBeInViewport();

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

test("uses the locked navigation path for a direct URL day", async ({ page, request }) => {
  const directions: string[] = [];
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (url.pathname === "/api/v1/entries/days" && url.searchParams.has("direction")) {
      directions.push(url.searchParams.get("direction")!);
    }
  });
  const fixture = await request.post("http://127.0.0.1:4174/__e2e__/large-fixture", {
    headers: { "x-diary-e2e-token": process.env.DIARY_E2E_RUN_ID ?? "" },
    data: { mode: "mixed" },
  });
  expect(fixture.ok()).toBeTruthy();
  await page.goto("/?fixture=large&day=2025-07-26");
  await expect(page.locator("#day-2025-07-26")).toBeInViewport();
  await waitForScrollSettled(page);
  expect(await page.locator("article.entry").count()).toBeLessThan(250);
  await expect(page.locator("main.reading-page")).toHaveAttribute("data-cached-entry-count", "120");
  expect(directions).toEqual([]);
});

test("keeps a dense-day search result visible and focused after locked navigation settles", async ({ page, request }) => {
  const denseDay = "2040-07-26";
  const fixture = await request.post("http://127.0.0.1:4174/__e2e__/large-fixture", {
    headers: { "x-diary-e2e-token": process.env.DIARY_E2E_RUN_ID ?? "" },
    data: { mode: "dense" },
  });
  expect(fixture.ok()).toBeTruthy();
  const firstPageResponse = await request.get(
    `http://127.0.0.1:4174/api/v1/entries/days?day=${denseDay}&limit=120`,
  );
  const firstPage = await firstPageResponse.json() as {
    days: Array<{ entries: Array<{ id: string; title: string }> }>;
  };
  const target = firstPage.days[0]!.entries[0]!;

  await page.goto(`/?fixture=large&day=${denseDay}`);
  await expect(page.locator(`#day-${denseDay}`)).toBeInViewport();
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByLabel("Search diary").fill(target.title);
  await page.getByRole("button", { name: target.title, exact: true }).first().click();

  const selected = page.locator(`[data-entry-id="${target.id}"]`);
  await expect(selected).toBeAttached();
  await waitForScrollSettled(page);
  await expect(selected).toBeInViewport();
  await expect(selected).toBeFocused();
  expect(await page.locator("article.entry").count()).toBeLessThan(250);
});

test("preserves an old entry while a real newer page is prepended after a date jump", async ({ page, request }) => {
  const fixture = await request.post("http://127.0.0.1:4174/__e2e__/large-fixture", {
    headers: { "x-diary-e2e-token": process.env.DIARY_E2E_RUN_ID ?? "" },
    data: { mode: "mixed" },
  });
  expect(fixture.ok()).toBeTruthy();
  await page.goto("/?fixture=large");
  await page.getByLabel("Jump to date").fill("2025-07-26");
  await page.getByRole("button", { name: "Go to July 26, 2025" }).click();
  await expect(page.locator("#day-2025-07-26")).toBeInViewport();
  await waitForScrollSettled(page);

  for (let index = 0; index < 4 && await page.getByTestId("top-window-spacer").count(); index += 1) {
    const before = await page.locator("article.entry").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.entryId).join("|"));
    await enterSentinel(page, "top-window-sentinel");
    await expect.poll(async () => page.locator("article.entry").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.entryId).join("|"))).not.toBe(before);
  }
  let releaseNewer!: () => void;
  const newerRelease = new Promise<void>((resolve) => { releaseNewer = resolve; });
  type AnchorSnapshot = { id: string; top: number };
  let markNewerRequested!: (snapshot: AnchorSnapshot) => void;
  const newerRequested = new Promise<AnchorSnapshot>((resolve) => { markNewerRequested = resolve; });
  await page.route("**/api/v1/entries/days?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("direction") !== "newer") {
      await route.continue();
      return;
    }
    const snapshot = await page.locator("article.entry").evaluateAll((nodes) => {
      const anchor = nodes
        .filter((node) => {
          const bounds = node.getBoundingClientRect();
          return bounds.bottom > 0 && bounds.top < window.innerHeight;
        })
        .sort((left, right) => Math.abs(left.getBoundingClientRect().top) - Math.abs(right.getBoundingClientRect().top))[0]!;
      return {
        id: anchor.getAttribute("data-entry-id")!,
        top: anchor.getBoundingClientRect().top,
      };
    });
    markNewerRequested(snapshot);
    await newerRelease;
    await route.continue();
  });
  const beforeCount = Number(await page.locator("main.reading-page").getAttribute("data-cached-entry-count"));
  await enterSentinel(page, "top-window-sentinel");
  const anchor = await newerRequested;
  releaseNewer();
  await expect.poll(async () => Number(await page.locator("main.reading-page").getAttribute("data-cached-entry-count"))).toBeGreaterThan(beforeCount);
  const restored = page.locator(`[data-entry-id="${anchor.id}"]`);
  await expect(restored).toBeAttached();
  await expect.poll(async () => Math.abs(((await restored.boundingBox())?.y ?? 0) - anchor.top)).toBeLessThanOrEqual(8);
});

test("streams a dense day older, newer, and older again with bounded cache and DOM", async ({ page, request }) => {
  const denseDay = "2040-07-26";
  const fixture = await request.post("http://127.0.0.1:4174/__e2e__/large-fixture", {
    headers: { "x-diary-e2e-token": process.env.DIARY_E2E_RUN_ID ?? "" },
    data: { mode: "dense" },
  });
  expect(fixture.ok()).toBeTruthy();

  const expected: Array<{ id: string; publishedAt: string }> = [];
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    const query = pageIndex === 0
      ? `day=${denseDay}&limit=120`
      : `direction=older&limit=120&cursor=${encodeURIComponent(cursor!)}`;
    const response = await request.get(`http://127.0.0.1:4174/api/v1/entries/days?${query}`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json() as {
      days: Array<{ totalEntries: number; entries: Array<{ id: string; publishedAt: string }> }>;
      nextCursor: string | null;
    };
    expect(body.days.flatMap((group) => group.entries)).toHaveLength(120);
    expect(body.days[0]?.totalEntries).toBe(20_000);
    expected.push(...body.days.flatMap((group) => group.entries));
    cursor = body.nextCursor;
  }
  for (let index = 1; index < expected.length; index += 1) {
    const previous = expected[index - 1]!;
    const current = expected[index]!;
    const tupleOrder = previous.publishedAt.localeCompare(current.publishedAt)
      || previous.id.localeCompare(current.id);
    expect(tupleOrder).toBeGreaterThan(0);
  }
  expect(new Set(expected.map((entry) => entry.id)).size).toBe(expected.length);

  await page.goto(`/?fixture=large&day=${denseDay}`);
  await expect(page.locator(`#day-${denseDay}`)).toBeInViewport();
  await waitForScrollSettled(page);
  const initial = await waitForEntryWindowSettled(page);
  const seen = [...initial];
  for (let transition = 0; transition < 12 && seen.length < expected.length; transition += 1) {
    const prior = await page.locator("article.entry").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.entryId).join("|"));
    await enterSentinel(page, "bottom-window-sentinel");
    await expect.poll(async () => page.locator("article.entry").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.entryId).join("|"))).not.toBe(prior);
    const next = await waitForEntryWindowSettled(page);
    for (const id of next) if (!seen.includes(id)) seen.push(id);
    expect(next.length).toBeLessThan(250);
    expect(new Set(next).size).toBe(next.length);
    expect(await page.locator(`section#day-${denseDay}`).count()).toBe(1);
    expect(Number(await page.locator("main.reading-page").getAttribute("data-cached-entry-count"))).toBeLessThanOrEqual(480);
  }
  expect(seen.slice(0, expected.length)).toEqual(expected.map((entry) => entry.id));

  for (let transition = 0; transition < 12; transition += 1) {
    const current = await waitForEntryWindowSettled(page);
    if (current[0] === expected[0]?.id) break;
    await enterSentinel(page, "top-window-sentinel");
    await expect.poll(async () => (await waitForEntryWindowSettled(page)).join("|")).not.toBe(current.join("|"));
  }
  const returned = await waitForEntryWindowSettled(page);
  expect(returned.slice(0, initial.length)).toEqual(initial);

  const beforeOlderAgain = returned.join("|");
  await enterSentinel(page, "bottom-window-sentinel");
  await expect.poll(async () => (await waitForEntryWindowSettled(page)).join("|")).not.toBe(beforeOlderAgain);
  expect(await page.locator("article.entry").count()).toBeLessThan(250);
});
