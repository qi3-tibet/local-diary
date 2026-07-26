import { useEffect, useRef, useState } from "react";
import {
  api,
  type BackupSettingsRecord,
  type RestoreEvent,
  type RestorePhase,
} from "../api/client";
import {
  browserDirectoryHandleStore,
  restoreGrantedDirectory,
  writeBlobToDirectory,
  type DiaryDirectoryHandle,
  type DirectoryHandleStore,
} from "./directory-handle-store";
import type { RestoreState } from "./RestoreProgress";

declare global {
  interface Window {
    diaryDesktop?: {
      chooseBackupDirectory(): Promise<string | null>;
    };
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: "read" | "readwrite";
    }) => Promise<DiaryDirectoryHandle>;
  }
}

type BackupClient = Pick<typeof api,
  | "getBackupSettings"
  | "setBackupLocation"
  | "createBackupSnapshot"
  | "fetchDownload"
  | "restoreBackup"
  | "markdownExportUrl"
>;

export function BackupSettings({
  client = api,
  handleStore = browserDirectoryHandleStore,
  fromDay,
  toDay,
  onRestoreState,
  onRestored,
  onWarning,
}: {
  client?: BackupClient;
  handleStore?: DirectoryHandleStore;
  fromDay?: string;
  toDay?: string;
  onRestoreState?: (state: RestoreState) => void;
  onRestored?: () => void;
  onWarning?: (warning: string | undefined) => void;
}) {
  const [settings, setSettings] = useState<BackupSettingsRecord>();
  const [exportDirectory, setExportDirectory] = useState<DiaryDirectoryHandle>();
  const [warning, setWarning] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [exportFrom, setExportFrom] = useState(fromDay ?? "");
  const [exportTo, setExportTo] = useState(toDay ?? "");
  const restoreFile = useRef<File | undefined>(undefined);
  const restoreAbort = useRef<AbortController | undefined>(undefined);
  const hasDesktopBridge = Boolean(window.diaryDesktop?.chooseBackupDirectory);
  const hasBrowserPicker = typeof window.showDirectoryPicker === "function";
  const canChooseLocation = hasDesktopBridge || hasBrowserPicker;

  useEffect(() => {
    let active = true;
    void Promise.all([
      client.getBackupSettings().then((value) => {
        if (!active) return;
        setSettings(value);
        if (!value.writable) setWarning("BACKUP LOCATION IS NOT WRITABLE");
      }),
      hasBrowserPicker
        ? restoreGrantedDirectory(handleStore).then((handle) => {
          if (active && handle) setExportDirectory(handle);
        })
        : Promise.resolve(),
    ]).catch(() => {
      if (active) setWarning("BACKUP SETTINGS COULD NOT BE OPENED");
    });
    return () => {
      active = false;
      restoreAbort.current?.abort();
    };
  }, [client, handleStore, hasBrowserPicker]);

  useEffect(() => {
    onWarning?.(warning);
  }, [onWarning, warning]);

  useEffect(() => {
    if (fromDay) setExportFrom(fromDay);
    if (toDay) setExportTo(toDay);
  }, [fromDay, toDay]);

  async function chooseLocation(): Promise<void> {
    setBusy(true);
    setStatus(undefined);
    try {
      if (window.diaryDesktop?.chooseBackupDirectory) {
        const chosen = await window.diaryDesktop.chooseBackupDirectory();
        if (!chosen) return;
        if (!absoluteOsPath(chosen)) throw new Error("BACKUP_LOCATION_UNSAFE");
        const verified = await client.setBackupLocation(chosen);
        setSettings(verified);
        setWarning(verified.writable ? undefined : "BACKUP LOCATION IS NOT WRITABLE");
        setStatus("BACKUP LOCATION VERIFIED");
        return;
      }
      if (window.showDirectoryPicker) {
        const handle = await window.showDirectoryPicker({
          id: "local-diary-manual-exports",
          mode: "readwrite",
        });
        setExportDirectory(handle);
        try {
          await handleStore.save(handle);
          setStatus("BROWSER EXPORT FOLDER READY");
        } catch {
          setStatus("BROWSER EXPORT FOLDER READY FOR THIS SESSION");
        }
      }
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") return;
      const message = error instanceof Error ? error.message : "";
      setWarning(message.includes("UNSAFE")
        ? "BACKUP LOCATION IS NOT SAFE"
        : "BACKUP LOCATION IS NOT WRITABLE");
    } finally {
      setBusy(false);
    }
  }

  async function createSnapshot(download: boolean): Promise<void> {
    setBusy(true);
    setStatus(download ? "PREPARING COMPLETE ARCHIVE" : "CREATING SNAPSHOT");
    try {
      const snapshot = await client.createBackupSnapshot();
      if (download) {
        await exportToSelectedDirectory(
          snapshot.archiveUrl,
          `diary-${snapshot.snapshotId}.zip`,
        );
      }
      setStatus(download ? "COMPLETE ARCHIVE READY" : "SNAPSHOT COMPLETE");
    } catch {
      setWarning("BACKUP COULD NOT BE CREATED");
    } finally {
      setBusy(false);
    }
  }

  async function exportMarkdown(): Promise<void> {
    if (!exportFrom || !exportTo || exportFrom > exportTo) {
      setWarning("CHOOSE A VALID BEIJING DATE RANGE");
      return;
    }
    setBusy(true);
    const url = client.markdownExportUrl(exportFrom, exportTo);
    try {
      await exportToSelectedDirectory(
        url,
        `diary-${exportFrom}-to-${exportTo}.zip`,
      );
      setStatus("MARKDOWN EXPORT READY");
    } catch {
      setWarning("MARKDOWN EXPORT COULD NOT BE CREATED");
    } finally {
      setBusy(false);
    }
  }

  async function exportToSelectedDirectory(url: string, filename: string): Promise<void> {
    if (!exportDirectory) {
      triggerDownload(url);
      return;
    }
    try {
      const blob = await client.fetchDownload(url);
      await writeBlobToDirectory(exportDirectory, filename, blob);
    } catch (error) {
      await handleStore.clear().catch(() => {});
      setExportDirectory(undefined);
      triggerDownload(url);
    }
  }

  async function startRestore(file: File): Promise<void> {
    restoreAbort.current?.abort();
    const controller = new AbortController();
    restoreAbort.current = controller;
    restoreFile.current = file;
    const history: RestorePhase[] = [];
    setBusy(true);
    setStatus(undefined);
    const retry = () => {
      if (restoreFile.current) void startRestore(restoreFile.current);
    };
    try {
      await client.restoreBackup(file, (event: RestoreEvent) => {
        history.push(event.phase);
        onRestoreState?.({
          phase: event.phase,
          history: [...history],
          ...(event.error ? { error: event.error } : {}),
          ...(event.phase === "FAILED" ? { retry } : {}),
        });
      }, controller.signal);
      onRestored?.();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (history.at(-1) !== "FAILED") history.push("FAILED");
      onRestoreState?.({
        phase: "FAILED",
        history: [...history],
        error: error instanceof Error ? error.message : "RESTORE_FAILED",
        retry,
      });
    } finally {
      if (restoreAbort.current === controller) {
        restoreAbort.current = undefined;
        setBusy(false);
      }
    }
  }

  return (
    <main className="management-page backup-settings" aria-labelledby="backup-settings-title">
      <header className="settings-heading">
        <p>LOCAL RECOVERY</p>
        <h1 id="backup-settings-title">BACKUP</h1>
      </header>

      {warning && !onWarning ? (
        <aside className="backup-warning" aria-live="polite">
          <p role="alert">{warning}</p>
          <button type="button" disabled={!canChooseLocation} onClick={() => void chooseLocation()}>
            CHOOSE ANOTHER LOCATION
          </button>
        </aside>
      ) : null}

      <section className="settings-section" aria-labelledby="backup-location-title">
        <div className="settings-section-heading">
          <h2 id="backup-location-title">LOCATION</h2>
          <span>SERVER MANAGED</span>
        </div>
        <div className="settings-location">
          <span>AUTOMATIC BACKUP LOCATION</span>
          <output aria-label="Automatic backup location">
            {settings?.backupRoot ?? "OPENING BACKUP SETTINGS"}
          </output>
        </div>
        <p className="settings-note">
          DAILY SNAPSHOTS USE THE SERVER-MANAGED LOCATION. EXISTING BACKUPS STAY
          IN THEIR PREVIOUS LOCATION.
        </p>
        {exportDirectory ? (
          <p className="settings-directory">
            BROWSER EXPORT FOLDER · {exportDirectory.name}
          </p>
        ) : null}
        <div className="settings-actions settings-actions-start">
          <button
            type="button"
            aria-label="Choose backup location"
            disabled={busy || !canChooseLocation}
            onClick={() => void chooseLocation()}
          >
            CHOOSE BACKUP LOCATION
          </button>
        </div>
        {!canChooseLocation ? (
          <p className="settings-note">
            DESKTOP APP REQUIRED TO CHANGE AUTOMATIC BACKUP LOCATION
          </p>
        ) : hasBrowserPicker && !hasDesktopBridge ? (
          <p className="settings-note">
            A BROWSER FOLDER IS USED ONLY FOR MANUAL EXPORTS. DAILY SNAPSHOTS
            CONTINUE IN THE SERVER-MANAGED LOCATION.
          </p>
        ) : null}
      </section>

      <section className="settings-section" aria-labelledby="backup-actions-title">
        <div className="settings-section-heading">
          <h2 id="backup-actions-title">PORTABILITY</h2>
          <span>VERIFIED ZIP</span>
        </div>
        <div className="settings-actions settings-actions-start">
          <button type="button" aria-label="Create snapshot" disabled={busy || !settings?.writable} onClick={() => void createSnapshot(false)}>
            CREATE SNAPSHOT
          </button>
          <button type="button" aria-label="Export complete archive" disabled={busy || !settings?.writable} onClick={() => void createSnapshot(true)}>
            EXPORT COMPLETE ARCHIVE
          </button>
        </div>
        <div className="export-range">
          <label className="settings-field">
            FROM
            <input aria-label="Export from" type="date" value={exportFrom} onChange={(event) => setExportFrom(event.target.value)} />
          </label>
          <label className="settings-field">
            TO
            <input aria-label="Export to" type="date" value={exportTo} onChange={(event) => setExportTo(event.target.value)} />
          </label>
          <button type="button" aria-label="Export portable Markdown" disabled={busy || !exportFrom || !exportTo} onClick={() => void exportMarkdown()}>
            EXPORT PORTABLE MARKDOWN
          </button>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="restore-title">
        <div className="settings-section-heading">
          <h2 id="restore-title">RESTORE</h2>
          <span>VALIDATION FIRST</span>
        </div>
        <p className="settings-note">
          CURRENT DATA IS REPLACED ONLY AFTER VALIDATION AND A SAFETY BACKUP.
        </p>
        <label className={`restore-file-action${busy ? " is-disabled" : ""}`}>
          RESTORE COMPLETE ARCHIVE
          <input
            className="visually-hidden"
            aria-label="Restore complete archive"
            type="file"
            accept=".zip,application/zip"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void startRestore(file);
            }}
          />
        </label>
      </section>

      {status ? <p className="settings-status" role="status">{status}</p> : null}
    </main>
  );
}

function absoluteOsPath(value: string): boolean {
  return value.startsWith("/")
    || /^[A-Za-z]:[\\/]/u.test(value)
    || /^\\\\[^\\]+\\[^\\]+/u.test(value);
}

function triggerDownload(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
