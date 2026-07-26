import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";
import { createThemeStore } from "./theme-store";

const bootstrapScript = readFileSync(
  fileURLToPath(new URL("../../public/theme-bootstrap.js", import.meta.url)),
  "utf8",
);

function fakeStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set("diary-theme", initial);
  const writes: Array<[string, string]> = [];

  return {
    writes,
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      writes.push([key, value]);
      values.set(key, value);
    },
  };
}

function runThemeBootstrap(script: string, remembered: string | null, systemDark: boolean) {
  const writes: Array<[string, string]> = [];
  const documentElement = {
    dataset: {} as Record<string, string>,
    style: { colorScheme: "" },
  };
  const bootstrapWindow = {
    localStorage: {
      getItem: () => remembered,
      setItem: (key: string, value: string) => writes.push([key, value]),
    },
    matchMedia: () => ({ matches: systemDark }),
  };

  Function("window", "document", script)(bootstrapWindow, { documentElement });
  return { documentElement, writes };
}

describe("theme store", () => {
  it("loads a synchronous external bootstrap before the application module", () => {
    expect(indexHtml).toContain('<script src="/theme-bootstrap.js"></script>');
    expect(indexHtml).not.toContain("<script data-theme-bootstrap>");
    expect(indexHtml.indexOf("/theme-bootstrap.js"))
      .toBeLessThan(indexHtml.indexOf("/src/main.tsx"));
  });

  it.each([
    ["remembered dark", "dark", false],
    ["system dark", "system", true],
  ] as const)("applies %s before React starts", (_case, remembered, systemDark) => {
    const { documentElement } = runThemeBootstrap(bootstrapScript, remembered, systemDark);

    expect(documentElement.dataset.theme).toBe("dark");
    expect(documentElement.style.colorScheme).toBe("dark");
  });

  it("repairs corrupt bootstrap storage without delaying system first paint", () => {
    const { documentElement, writes } = runThemeBootstrap(bootstrapScript, "sepia", false);

    expect(documentElement.dataset.theme).toBe("light");
    expect(writes).toContainEqual(["diary-theme", "system"]);
  });

  it("follows Windows until a remembered override is selected", () => {
    const storage = fakeStorage();
    const store = createThemeStore(storage, () => true);

    expect(store.getState().resolved).toBe("dark");
    store.getState().setPreference("light");
    expect(store.getState()).toMatchObject({ preference: "light", resolved: "light" });
    expect(storage.getItem("diary-theme")).toBe("light");
  });

  it("restores a remembered override and returns to the live system theme", () => {
    let systemDark = false;
    const store = createThemeStore(fakeStorage("dark"), () => systemDark);

    expect(store.getState()).toMatchObject({ preference: "dark", resolved: "dark" });
    store.getState().setPreference("system");
    expect(store.getState().resolved).toBe("light");

    systemDark = true;
    store.getState().syncSystem();
    expect(store.getState().resolved).toBe("dark");
  });

  it("does not react to system changes while an explicit override is active", () => {
    let systemDark = false;
    const store = createThemeStore(fakeStorage("dark"), () => systemDark);

    systemDark = true;
    store.getState().syncSystem();
    expect(store.getState()).toMatchObject({ preference: "dark", resolved: "dark" });
  });

  it("repairs unknown stored preferences back to system", () => {
    const storage = fakeStorage("sepia");
    const store = createThemeStore(storage, () => false);

    expect(store.getState()).toMatchObject({ preference: "system", resolved: "light" });
    expect(storage.writes).toContainEqual(["diary-theme", "system"]);
  });
});
