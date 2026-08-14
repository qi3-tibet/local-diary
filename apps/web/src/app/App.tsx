import type { Entry } from "@diary/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { api } from "../api/client";
import {
  createDayPageCache,
  mergeDayPages,
  type DayPageCache,
} from "./day-page-cache";
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

type View = "diary" | "editor" | "search" | "trash" | "settings";
type JumpTarget = {
  day: string;
  entryId?: string;
};

export function App() {
  const [player] = useState(getBrowserPlayerStore);
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("diary");
  const [editingEntry, setEditingEntry] = useState<Entry>();
  const [managementError, setManagementError] = useState<string>();
  const [restoreState, setRestoreState] = useState<RestoreState>();
  const [backupWarning, setBackupWarning] = useState<string>();
  const editorLeave = useRef<(() => Promise<boolean>) | undefined>(undefined);
  const pendingEditorLeave = useRef<Promise<boolean> | undefined>(undefined);
  const handledRequestedDay = useRef(false);
  const navigationGeneration = useRef(0);
  const navigationLocked = useRef(false);
  const pagingSequence = useRef(0);
  const activePagingRequest = useRef<number | undefined>(undefined);
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
  const calendarDaysQuery = useQuery({
    queryKey: ["calendar-days"],
    queryFn: api.listCalendarDays,
  });
  const draftRecoveryQuery = useQuery({
    queryKey: ["draft"],
    queryFn: api.getDraft,
  });
  const [dayPage, setDayPage] = useState<DayPageCache>();
  const entries = dayPage?.days.flatMap((group) => group.entries) ?? [];
  const days = useMemo(
    () => groupEntriesByBeijingDay(entries).map((group) => group.day),
    [entries],
  );
  const [activeDay, setActiveDay] = useState<string>();
  const [jumpTarget, setJumpTarget] = useState<JumpTarget>();
  const [navigationReady, setNavigationReady] = useState(false);
  const [timelineNavigationKey, setTimelineNavigationKey] = useState(0);
  const sortedDays = useMemo(() => [...days].sort(), [days]);
  const restoreLocked = restoreState
    ? ["SAFETY_BACKUP", "RESTORING", "REBUILDING"].includes(restoreState.phase)
    : false;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    if (!entriesQuery.data) return;
    if (requestedDay && !handledRequestedDay.current) {
      handledRequestedDay.current = true;
      beginNavigation({ day: requestedDay });
      applyDayNavigation(requestedDay, entriesQuery.data);
    } else {
      setDayPage(createDayPageCache(entriesQuery.data));
    }
  }, [entriesQuery.data, requestedDay]);

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
    if (!jumpTarget || !navigationReady) return;
    let restoreScrollBehavior: (() => void) | undefined;
    let active = true;
    let frame = 0;
    const seekAndScroll = () => {
      if (!active) return;
      const target = jumpTarget.entryId
        ? [...document.querySelectorAll<HTMLElement>("[data-entry-id]")]
            .find((element) => element.dataset.entryId === jumpTarget.entryId)
        : document.getElementById(`day-${jumpTarget.day}`);
      if (!target) {
        frame = window.requestAnimationFrame(seekAndScroll);
        return;
      }
      const root = document.documentElement;
      const scrollBehavior = root.style.scrollBehavior;
      root.style.scrollBehavior = "auto";
      restoreScrollBehavior = () => {
        root.style.scrollBehavior = scrollBehavior;
        restoreScrollBehavior = undefined;
      };
      target.scrollIntoView({
        block: jumpTarget.entryId ? "center" : "start",
        behavior: "auto",
      });
      target.focus({ preventScroll: true });
      let previous = window.scrollY;
      let previousTop = target.getBoundingClientRect().top;
      let stableFrames = 0;
      const finishWhenSettled = () => {
        if (!active) return;
        const next = window.scrollY;
        const nextTop = target.getBoundingClientRect().top;
        stableFrames = Math.abs(next - previous) < 0.5 && Math.abs(nextTop - previousTop) < 0.5
          ? stableFrames + 1
          : 0;
        previous = next;
        previousTop = nextTop;
        if (stableFrames >= 4) {
          restoreScrollBehavior?.();
          navigationLocked.current = false;
          setNavigationReady(false);
          setJumpTarget(undefined);
        }
        else frame = window.requestAnimationFrame(finishWhenSettled);
      };
      frame = window.requestAnimationFrame(finishWhenSettled);
    };
    frame = window.requestAnimationFrame(seekAndScroll);
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      restoreScrollBehavior?.();
    };
  }, [dayPage, jumpTarget, navigationReady]);

  async function leaveEditorThen(action: () => void | Promise<void>): Promise<void> {
    if (view !== "editor") {
      await action();
      return;
    }
    let leave = pendingEditorLeave.current;
    if (!leave) {
      leave = Promise.resolve(editorLeave.current ? editorLeave.current() : true)
        .catch(() => false)
        .finally(() => {
          if (pendingEditorLeave.current === leave) pendingEditorLeave.current = undefined;
        });
      pendingEditorLeave.current = leave;
    }
    if (await leave) await action();
  }

  function showDiary(): Promise<void> {
    return leaveEditorThen(() => {
      setEditingEntry(undefined);
      setManagementError(undefined);
      setView("diary");
    });
  }

  function showNewEntry(): Promise<void> {
    return leaveEditorThen(() => {
      setEditingEntry(undefined);
      setView("editor");
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>('[aria-label="Title"]')?.focus();
      });
    });
  }

  function showSearch(): Promise<void> {
    return leaveEditorThen(() => {
      setView("search");
    });
  }

  function showTrash(): Promise<void> {
    return leaveEditorThen(() => {
      setView("trash");
    });
  }

  function showSettings(): Promise<void> {
    return leaveEditorThen(() => {
      setView("settings");
    });
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
      queryClient.invalidateQueries({ queryKey: ["calendar-days"] }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
      queryClient.invalidateQueries({ queryKey: ["trash"] }),
    ]);
  }

  async function restoreEntry(entry: Entry): Promise<void> {
    await api.restoreEntry(entry.id);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["published-entries"] }),
      queryClient.invalidateQueries({ queryKey: ["calendar-days"] }),
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

  function completeEditor(completedEntry: Entry): void {
    const returnToEditedEntry = Boolean(editingEntry);
    setEditingEntry(undefined);
    setManagementError(undefined);
    setView((current) => current === "editor" ? "diary" : current);
    void Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: ["draft"] }),
      queryClient.invalidateQueries({ queryKey: ["published-entries"] }),
      queryClient.invalidateQueries({ queryKey: ["calendar-days"] }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
    ]).then(() => {
      if (returnToEditedEntry) {
        return navigateToEntry(completedEntry, "THE EDITED ENTRY COULD NOT BE OPENED");
      }
      return undefined;
    });
  }

  function restoredDiary(): void {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["draft"] }),
      queryClient.invalidateQueries({ queryKey: ["published-entries"] }),
      queryClient.invalidateQueries({ queryKey: ["calendar-days"] }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
      queryClient.invalidateQueries({ queryKey: ["trash"] }),
    ]);
    showDiary();
  }

  function openBackupRecovery(): void {
    void leaveEditorThen(() => {
      setView("settings");
      window.requestAnimationFrame(() => {
        const button = document.querySelector<HTMLButtonElement>('[aria-label="Choose backup location"]');
        button?.focus();
      });
    });
  }

  async function openSearchResult(entry: Entry): Promise<void> {
    showDiary();
    await navigateToEntry(entry, "THE ENTRY COULD NOT BE OPENED");
  }

  async function navigateToEntry(entry: Entry, errorMessage: string): Promise<void> {
    if (!entry.publishedAt) return;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(entry.publishedAt));
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    const day = `${value("year")}-${value("month")}-${value("day")}`;
    const generation = beginNavigation({ day, entryId: entry.id });
    try {
      const next = await api.listDayPage({ entryId: entry.id });
      if (generation !== navigationGeneration.current) return;
      applyDayNavigation(day, next, entry.id);
    } catch {
      failNavigation(generation, errorMessage);
    }
  }

  async function loadOlder(): Promise<void> {
    if (
      navigationLocked.current
      || !dayPage?.nextCursor
      || activePagingRequest.current !== undefined
    ) return;
    const generation = navigationGeneration.current;
    const requestId = ++pagingSequence.current;
    activePagingRequest.current = requestId;
    try {
      const next = await api.listDayPage({ cursor: dayPage.nextCursor, direction: "older" });
      if (
        generation !== navigationGeneration.current
        || activePagingRequest.current !== requestId
      ) return;
      setDayPage((current) => current
        ? mergeDayPages(current, next, "older")
        : createDayPageCache(next));
    } catch {
      if (generation === navigationGeneration.current) await entriesQuery.refetch();
    } finally {
      if (activePagingRequest.current === requestId) activePagingRequest.current = undefined;
    }
  }

  async function loadNewer(): Promise<void> {
    if (
      navigationLocked.current
      || !dayPage?.previousCursor
      || activePagingRequest.current !== undefined
    ) return;
    const generation = navigationGeneration.current;
    const requestId = ++pagingSequence.current;
    activePagingRequest.current = requestId;
    try {
      const next = await api.listDayPage({ cursor: dayPage.previousCursor, direction: "newer" });
      if (
        generation !== navigationGeneration.current
        || activePagingRequest.current !== requestId
      ) return;
      setDayPage((current) => current
        ? mergeDayPages(current, next, "newer")
        : createDayPageCache(next));
    } catch {
      if (generation === navigationGeneration.current) await entriesQuery.refetch();
    } finally {
      if (activePagingRequest.current === requestId) activePagingRequest.current = undefined;
    }
  }

  async function jumpToDay(day: string): Promise<void> {
    const generation = beginNavigation({ day });
    if (days.includes(day)) {
      if (generation !== navigationGeneration.current) return;
      setActiveDay(day);
      setTimelineNavigationKey((value) => value + 1);
      setNavigationReady(true);
      return;
    }
    try {
      const next = await api.listDayPage({ day });
      if (generation !== navigationGeneration.current) return;
      applyDayNavigation(day, next);
    } catch {
      failNavigation(generation, "THE DATE COULD NOT BE OPENED");
    }
  }

  function beginNavigation(target: JumpTarget): number {
    navigationGeneration.current += 1;
    navigationLocked.current = true;
    activePagingRequest.current = undefined;
    setManagementError(undefined);
    setNavigationReady(false);
    setJumpTarget(target);
    return navigationGeneration.current;
  }

  function failNavigation(generation: number, message: string): void {
    if (generation !== navigationGeneration.current) return;
    navigationLocked.current = false;
    setNavigationReady(false);
    setJumpTarget(undefined);
    setManagementError(message);
  }

  function applyDayNavigation(
    day: string,
    next: Awaited<ReturnType<typeof api.listDayPage>>,
    entryId?: string,
  ): void {
    const targetDay = nearestReturnedDay(day, next.days.map((group) => group.day));
    const containsEntry = entryId
      ? next.days.some((group) => group.entries.some((entry) => entry.id === entryId))
      : false;
    setJumpTarget(targetDay
      ? { day: targetDay, entryId: containsEntry ? entryId : undefined }
      : undefined);
    setNavigationReady(Boolean(targetDay));
    if (!targetDay) navigationLocked.current = false;
    setDayPage(createDayPageCache(next));
    setActiveDay(targetDay);
    setTimelineNavigationKey((value) => value + 1);
  }

  let content;
  if (view === "editor") {
    content = (
      <Editor
        entry={editingEntry}
        onCancel={showDiary}
        onComplete={completeEditor}
        onRegisterLeave={(leave) => {
          editorLeave.current = leave;
          return () => {
            if (editorLeave.current === leave) editorLeave.current = undefined;
          };
        }}
      />
    );
  } else if (view === "search") {
    content = (
      <SearchPanel
        onEdit={editEntry}
        onOpen={(entry) => void openSearchResult(entry)}
        onTrash={trashEntry}
      />
    );
  } else if (view === "trash") {
    content = <TrashPanel onRestore={restoreEntry} />;
  } else if (entriesQuery.isError) {
    content = (
      <div className="reading-status" role="alert">
        <p>THE DIARY COULD NOT BE OPENED</p>
        <button type="button" onClick={() => void entriesQuery.refetch()}>
          TRY AGAIN
        </button>
      </div>
    );
  } else if (entriesQuery.isPending || !dayPage) {
    content = (
      <p className="reading-status" role="status">
        OPENING DIARY
      </p>
    );
  } else {
    content = (
      <WindowedTimeline
        entries={entries}
        activeDay={activeDay}
        totalEntriesByDay={Object.fromEntries(dayPage?.days.map((group) => [group.day, group.totalEntries]) ?? [])}
        preserveAnchor={!jumpTarget}
        pagingEnabled={!jumpTarget}
        navigationResetKey={timelineNavigationKey}
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
        availableDays={calendarDaysQuery.data ?? days}
        activeDay={activeDay}
        onJumpDay={(day) => void jumpToDay(day)}
        footer={<ThemeControl preference={preference} onChange={setPreference} />}
      />
      <div className="app-main">
        <nav className="workspace-tools" aria-label="Diary tools">
          <button type="button" aria-label="Diary" disabled={restoreLocked} onClick={() => void showDiary()}>DIARY</button>
          <button
            type="button"
            aria-label="New entry"
            disabled={restoreLocked}
            onClick={() => void showNewEntry()}
          >
            NEW ENTRY
          </button>
          <button type="button" aria-label="Search" disabled={restoreLocked} onClick={() => void showSearch()}>
            SEARCH
          </button>
          <button type="button" aria-label="Trash" disabled={restoreLocked} onClick={() => void showTrash()}>
            TRASH
          </button>
          <button type="button" aria-label="Settings" disabled={restoreLocked} onClick={() => void showSettings()}>
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

function nearestReturnedDay(requestedDay: string, returnedDays: string[]): string | undefined {
  if (returnedDays.includes(requestedDay)) return requestedDay;
  const requestedTime = Date.parse(`${requestedDay}T00:00:00.000Z`);
  return [...returnedDays].sort((left, right) => {
    const distance = Math.abs(Date.parse(`${left}T00:00:00.000Z`) - requestedTime)
      - Math.abs(Date.parse(`${right}T00:00:00.000Z`) - requestedTime);
    return distance || right.localeCompare(left);
  })[0];
}
