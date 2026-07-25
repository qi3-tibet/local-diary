import { describe, expect, it } from "vitest";
import { createThemeStore } from "./theme-store";

function fakeStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set("diary-theme", initial);

  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("theme store", () => {
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

  it("ignores unknown stored preferences", () => {
    const store = createThemeStore(fakeStorage("sepia"), () => false);

    expect(store.getState()).toMatchObject({ preference: "system", resolved: "light" });
  });
});
