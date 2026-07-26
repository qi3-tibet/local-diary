import type { Entry } from "@diary/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { api, type DayPage } from "../api/client";
import { DateRail } from "../diary/DateRail";
import { WindowedTimeline } from "../diary/WindowedTimeline";
import { groupEntriesByBeijingDay } from "../diary/date-groups";
import { Editor } from "../editor/Editor";
import { SearchPanel } from "../search/SearchPanel";
import { ThemeControl } from "../theme/ThemeControl";
import { createThemeStore } from "../theme/theme-store";
import { TrashPanel } from "../trash/TrashPanel";
import { FloatingPlayer } from "../music/FloatingPlayer";
import { getBrowserPlayerStore } from "../music/player-store";
import { BackupSettings } from "../settings/BackupSettings";
import { RestoreProgress, type RestoreState } from "../settings/RestoreProgress";
import { prefersReducedMotion } from "../a11y/reduced-motion";

type View = "diary" | "editor" | "search" | "trash" | "settings";

export function App() {
  const [player] = useState(getBrowserPlayerStore);
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("diary");
  const [editingEntry, setEditingEntry] = useState<Entry>();
  const [managementError, setManagementError] = useState<string>();
  const [restoreState, setRestoreState] = useState<RestoreState>();
  const [backupWarning, setBackupWarning] = useState<string>();
  const checkedDraftRecovery = useRef(false);
  const paging = useRef(false);
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
  const requestedDay = new URLSearchParams(window.location.search).get("day") ?? undefined;
  const entriesQuery = useQuery({
    queryKey: ["published-entries", requestedDay],
    queryFn: () => api.listDayPage({ day: requestedDay }),
  });
  const draftRecoveryQuery = useQuery({
    queryKey: ["draft"],
    queryFn: api.getDraft,
  });
  const [dayPage, setDayPage] = useState<DayPage>();
  const entries = dayPage?.days.flatMap((group) => group.entries) ?? [];
  const days = useMemo(
    () => groupEntriesByBeijingDay(entries).map((group) => group.day),
    [entries],
  );
  const [activeDay, setActiveDay] = useState<string>();
  const [jumpTarget, setJumpTarget] = useState<string>();
  const sortedDays = useMemo(() => [...days].sort(), [days]);
  const restoreLocked = restoreState
    ? ["SAFETY_BACKUP", "RESTORING", "REBUILDING"].includes(restoreState.phase)
    : false;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    if (entriesQuery.data) setDayPage(entriesQuery.data);
  }, [entriesQuery.data]);

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
    if (activeDay) player.getState().setVisibleDay(activeDay);
  }, [activeDay, player]);

  useEffect(() => {
    if (!requestedDay || !entriesQuery.isSuccess) return;
    window.requestAnimationFrame(() => {
      document.getElementById(`day-${requestedDay}`)?.scrollIntoView({ block: "start", behavior: "auto" });
    });
  }, [entriesQuery.isSuccess, requestedDay]);

  useEffect(() => {
    if (!jumpTarget) return;
    window.requestAnimationFrame(() => {
      const section = document.getElementById(`day-${jumpTarget}`);
      if (!section) return;
      section.scrollIntoView({ block: "center", behavior: "auto" });
      section.focus({ preventScroll: true });
      setJumpTarget(undefined);
    });
  }, [dayPage, jumpTarget]);

  useEffect(() => {
    if (!draftRecoveryQuery.isSuccess || checkedDraftRecovery.current) return;
    checkedDraftRecovery.current = true;
    if (draftRecoveryQuery.data) setView("editor");
  }, [draftRecoveryQuery.data, draftRecoveryQuery.isSuccess]);

  function showDiary(): void {
    checkedDraftRecovery.current = true;
    setEditingEntry(undefined);
    setManagementError(undefined);
    setView("diary");
  }

  function editEntry(entry: Entry): void {
    checkedDraftRecovery.current = true;
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
    checkedDraftRecovery.current = true;
    setEditingEntry(undefined);
    setManagementError(undefined);
    setView((current) => current === "editor" ? "diary" : current);
  }

  function restoredDiary(): void {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["draft"] }),
      queryClient.invalidateQueries({ queryKey: ["published-entries"] }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
      queryClient.invalidateQueries({ queryKey: ["trash"] }),
    ]);
    showDiary();
  }

  function openBackupRecovery(): void {
    checkedDraftRecovery.current = true;
    setView("settings");
    window.requestAnimationFrame(() => {
      const button = document.querySelector<HTMLButtonElement>('[aria-label="Choose backup location"]');
      button?.focus();
    });
  }

  function openSearchResult(entry: Entry): void {
    showDiary();
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-entry-id="${entry.id}"]`)?.scrollIntoView({
        block: "center",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    });
  }

  function mergeDays(current: DayPage, incoming: DayPage, position: "older" | "newer"): DayPage {
    const known = new Set(current.days.map((group) => group.day));
    const additions = incoming.days.filter((group) => !known.has(group.day));
    const combined = position === "older"
      ? [...additions, ...current.days]
      : [...current.days, ...additions];
    const bounded = combined.length > 60
      ? (position === "older" ? combined.slice(0, 60) : combined.slice(-60))
      : combined;
    return {
      days: bounded,
      previousCursor: position === "newer" ? incoming.previousCursor : current.previousCursor,
      nextCursor: position === "older" ? incoming.nextCursor : current.nextCursor,
    };
  }

  async function loadOlder(): Promise<void> {
    if (!dayPage?.nextCursor || paging.current) return;
    paging.current = true;
    try {
      const next = await api.listDayPage({ cursor: dayPage.nextCursor, direction: "older" });
      setDayPage((current) => current ? mergeDays(current, next, "older") : next);
    } catch {
      await entriesQuery.refetch();
    } finally {
      paging.current = false;
    }
  }

  async function loadNewer(): Promise<void> {
    if (!dayPage?.previousCursor || paging.current) return;
    paging.current = true;
    try {
      const next = await api.listDayPage({ cursor: dayPage.previousCursor, direction: "newer" });
      setDayPage((current) => current ? mergeDays(current, next, "newer") : next);
    } catch {
      await entriesQuery.refetch();
    } finally {
      paging.current = false;
    }
  }

  async function jumpToDay(day: string): Promise<void> {
    const next = await api.listDayPage({ day });
    setJumpTarget(day);
    setDayPage(next);
    setActiveDay(day);
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
      <WindowedTimeline
        entries={entries}
        activeDay={activeDay}
        preserveAnchor={!jumpTarget}
        pagingEnabled={!jumpTarget}
        onNeedOlder={() => void loadOlder()}
        onNeedNewer={() => void loadNewer()}
        onActiveDayChange={(day) => { if (!jumpTarget) setActiveDay(day); }}
        onEditEntry={editEntry}
        onTrashEntry={(entry) => void trashFromTimeline(entry)}
        player={player}
      />
    );
  }

  return (
    <div className="app-shell" id="top">
      <DateRail
        entries={entries}
        activeDay={activeDay}
        onJumpDay={(day) => void jumpToDay(day)}
        footer={<ThemeControl preference={preference} onChange={setPreference} />}
      />
      <div className="app-main">
        <nav className="workspace-tools" aria-label="Diary tools">
          <button type="button" aria-label="Diary" disabled={restoreLocked} onClick={showDiary}>DIARY</button>
          <button
            type="button"
            aria-label="New entry"
            disabled={restoreLocked}
            onClick={() => {
              checkedDraftRecovery.current = true;
              setEditingEntry(undefined);
              setView("editor");
            }}
          >
            NEW ENTRY
          </button>
          <button type="button" aria-label="Search" disabled={restoreLocked} onClick={() => {
            checkedDraftRecovery.current = true;
            setView("search");
          }}>
            SEARCH
          </button>
          <button type="button" aria-label="Trash" disabled={restoreLocked} onClick={() => {
            checkedDraftRecovery.current = true;
            setView("trash");
          }}>
            TRASH
          </button>
          <button type="button" aria-label="Settings" disabled={restoreLocked} onClick={() => {
            checkedDraftRecovery.current = true;
            setView("settings");
          }}>
            SETTINGS
          </button>
        </nav>
        {managementError ? (
          <p className="workspace-error" role="alert">{managementError}</p>
        ) : null}
        {backupWarning ? (
          <aside className="persistent-backup-warning" aria-live="polite">
            <p role="alert">{backupWarning}</p>
            <button type="button" onClick={openBackupRecovery}>CHOOSE ANOTHER LOCATION</button>
          </aside>
        ) : null}
        <div hidden={view !== "settings"}>
          <BackupSettings
            fromDay={sortedDays[0]}
            toDay={sortedDays.at(-1)}
            onRestoreState={setRestoreState}
            onRestored={restoredDiary}
            onWarning={setBackupWarning}
          />
        </div>
        {view === "settings" ? null : content}
      </div>
      {restoreState ? <RestoreProgress state={restoreState} /> : null}
      <FloatingPlayer player={player} />
    </div>
  );
}
