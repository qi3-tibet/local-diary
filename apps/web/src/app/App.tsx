import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { api } from "../api/client";
import { DateRail } from "../diary/DateRail";
import { Timeline } from "../diary/Timeline";
import { groupEntriesByBeijingDay } from "../diary/date-groups";
import { ThemeControl } from "../theme/ThemeControl";
import { createThemeStore } from "../theme/theme-store";

export function App() {
  const [themeSession] = useState(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    return {
      media,
      store: createThemeStore(window.localStorage, () => media.matches),
    };
  });
  const preference = useStore(themeSession.store, (state) => state.preference);
  const resolvedTheme = useStore(themeSession.store, (state) => state.resolved);
  const setPreference = useStore(themeSession.store, (state) => state.setPreference);
  const entriesQuery = useQuery({
    queryKey: ["published-entries"],
    queryFn: api.listEntries,
  });
  const entries = entriesQuery.data ?? [];
  const days = useMemo(
    () => groupEntriesByBeijingDay(entries).map((group) => group.day),
    [entries],
  );
  const [activeDay, setActiveDay] = useState<string>();

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    const syncSystem = () => themeSession.store.getState().syncSystem();
    themeSession.media.addEventListener("change", syncSystem);
    return () => themeSession.media.removeEventListener("change", syncSystem);
  }, [themeSession]);

  useEffect(() => {
    if (days.length > 0 && (!activeDay || !days.includes(activeDay))) {
      setActiveDay(days[0]);
    }
  }, [activeDay, days]);

  return (
    <div className="app-shell" id="top">
      <DateRail
        entries={entries}
        activeDay={activeDay}
        footer={<ThemeControl preference={preference} onChange={setPreference} />}
      />
      <div className="app-main">
        {entriesQuery.isPending ? (
          <p className="reading-status" role="status">
            OPENING DIARY
          </p>
        ) : entriesQuery.isError ? (
          <div className="reading-status" role="alert">
            <p>THE DIARY COULD NOT BE OPENED</p>
            <button type="button" onClick={() => void entriesQuery.refetch()}>
              TRY AGAIN
            </button>
          </div>
        ) : (
          <Timeline entries={entries} onActiveDayChange={setActiveDay} />
        )}
      </div>
    </div>
  );
}
