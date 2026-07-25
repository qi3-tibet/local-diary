import type { Entry } from "@diary/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { api } from "../api/client";
import { DateRail } from "../diary/DateRail";
import { Timeline } from "../diary/Timeline";
import { groupEntriesByBeijingDay } from "../diary/date-groups";
import { Editor } from "../editor/Editor";
import { SearchPanel } from "../search/SearchPanel";
import { ThemeControl } from "../theme/ThemeControl";
import { createThemeStore } from "../theme/theme-store";
import { TrashPanel } from "../trash/TrashPanel";

type View = "diary" | "editor" | "search" | "trash";

export function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("diary");
  const [editingEntry, setEditingEntry] = useState<Entry>();
  const [managementError, setManagementError] = useState<string>();
  const checkedDraftRecovery = useRef(false);
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
  const draftRecoveryQuery = useQuery({
    queryKey: ["draft"],
    queryFn: api.getDraft,
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

  useEffect(() => {
    if (!draftRecoveryQuery.isSuccess || checkedDraftRecovery.current) return;
    checkedDraftRecovery.current = true;
    if (draftRecoveryQuery.data) setView("editor");
  }, [draftRecoveryQuery.data, draftRecoveryQuery.isSuccess]);

  function showDiary(): void {
    setEditingEntry(undefined);
    setManagementError(undefined);
    setView("diary");
  }

  function editEntry(entry: Entry): void {
    setEditingEntry(entry);
    setManagementError(undefined);
    setView("editor");
  }

  async function trashEntry(entry: Entry): Promise<void> {
    await api.trashEntry(entry.id);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["published-entries"] }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
      queryClient.invalidateQueries({ queryKey: ["trash"] }),
    ]);
  }

  async function restoreEntry(entry: Entry): Promise<void> {
    await api.restoreEntry(entry.id);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["published-entries"] }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
      queryClient.invalidateQueries({ queryKey: ["trash"] }),
    ]);
  }

  async function trashFromTimeline(entry: Entry): Promise<void> {
    setManagementError(undefined);
    try {
      await trashEntry(entry);
    } catch {
      setManagementError("THE ENTRY COULD NOT BE MOVED TO TRASH");
    }
  }

  function completeEditor(): void {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["draft"] }),
      queryClient.invalidateQueries({ queryKey: ["published-entries"] }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
    ]);
    showDiary();
  }

  function openSearchResult(entry: Entry): void {
    showDiary();
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-entry-id="${entry.id}"]`)?.scrollIntoView({
        block: "center",
      });
    });
  }

  let content;
  if (view === "editor") {
    content = (
      <Editor
        entry={editingEntry}
        onCancel={showDiary}
        onComplete={completeEditor}
      />
    );
  } else if (view === "search") {
    content = (
      <SearchPanel
        onEdit={editEntry}
        onOpen={openSearchResult}
        onTrash={trashEntry}
      />
    );
  } else if (view === "trash") {
    content = <TrashPanel onRestore={restoreEntry} />;
  } else if (entriesQuery.isPending) {
    content = (
      <p className="reading-status" role="status">
        OPENING DIARY
      </p>
    );
  } else if (entriesQuery.isError) {
    content = (
      <div className="reading-status" role="alert">
        <p>THE DIARY COULD NOT BE OPENED</p>
        <button type="button" onClick={() => void entriesQuery.refetch()}>
          TRY AGAIN
        </button>
      </div>
    );
  } else {
    content = (
      <Timeline
        entries={entries}
        onActiveDayChange={setActiveDay}
        onEditEntry={editEntry}
        onTrashEntry={(entry) => void trashFromTimeline(entry)}
      />
    );
  }

  return (
    <div className="app-shell" id="top">
      <DateRail
        entries={entries}
        activeDay={activeDay}
        footer={<ThemeControl preference={preference} onChange={setPreference} />}
      />
      <div className="app-main">
        <nav className="workspace-tools" aria-label="Diary tools">
          <button type="button" aria-label="Diary" onClick={showDiary}>DIARY</button>
          <button
            type="button"
            aria-label="New entry"
            onClick={() => {
              setEditingEntry(undefined);
              setView("editor");
            }}
          >
            NEW ENTRY
          </button>
          <button type="button" aria-label="Search" onClick={() => setView("search")}>
            SEARCH
          </button>
          <button type="button" aria-label="Trash" onClick={() => setView("trash")}>
            TRASH
          </button>
        </nav>
        {managementError ? (
          <p className="workspace-error" role="alert">{managementError}</p>
        ) : null}
        {content}
      </div>
    </div>
  );
}
