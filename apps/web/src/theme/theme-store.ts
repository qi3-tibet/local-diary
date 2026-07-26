import { createStore } from "zustand/vanilla";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

type ThemeState = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference(preference: ThemePreference): void;
  syncSystem(): void;
};

const THEME_STORAGE_KEY = "diary-theme";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function createThemeStore(storage: ThemeStorage, systemIsDark: () => boolean) {
  const remembered = storage.getItem(THEME_STORAGE_KEY);
  const preference: ThemePreference = isThemePreference(remembered) ? remembered : "system";
  if (remembered !== null && !isThemePreference(remembered)) {
    storage.setItem(THEME_STORAGE_KEY, "system");
  }
  const resolve = (next: ThemePreference): ResolvedTheme =>
    next === "system" ? (systemIsDark() ? "dark" : "light") : next;

  return createStore<ThemeState>()((set, get) => ({
    preference,
    resolved: resolve(preference),
    setPreference(nextPreference) {
      storage.setItem(THEME_STORAGE_KEY, nextPreference);
      set({ preference: nextPreference, resolved: resolve(nextPreference) });
    },
    syncSystem() {
      if (get().preference === "system") {
        set({ resolved: resolve("system") });
      }
    },
  }));
}
