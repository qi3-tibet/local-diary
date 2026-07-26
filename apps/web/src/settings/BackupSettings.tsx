import { useEffect, useRef, useState } from "react";
import {
  api,
  type BackupSettingsRecord,
  type RestoreEvent,
  type RestorePhase,
} from "../api/client";
import type { RestoreState } from "./RestoreProgress";

declare global {
  interface Window {
    diaryDesktop?: {
      chooseBackupDirectory(): Promise<string | null>;
    };
  }
}

type BackupClient = Pick<typeof api,
  | "getBackupSettings"
  | "setBackupLocation"
  | "createBackupSnapshot"
  | "restoreBackup"
  | "markdownExportUrl"
>;

export function BackupSettings({
  client = api,
  fromDay,
  toDay,
  onRestoreState,
  onRestored,
  onWarning,
}: {
  client?: BackupClient;
  fromDay?: string;
  toDay?: string;
  onRestoreState?: (state: RestoreState) => void;
  onRestored?: () => void;
  onWarning?: (warning: string | undefined) => void;
}) {
  const [settings, setSettings] = useState<BackupSettingsRecord>();
  const [pathValue, setPathValue] = useState("");
  const [warning, setWarning] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [exportFrom, setExportFrom] = useState(fromDay ?? "");
  const [exportTo, setExportTo] = useState(toDay ?? "");
  const pathInput = useRef<HTMLInputElement>(null);
  const restoreFile = useRef<File | undefined>(undefined);
  const restoreAbort = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void client.getBackupSettings().then((value) => {
      if (!active) return;
      setSettings(value);
      setPathValue(value.backupRoot);
      if (!value.writable) setWarning("BACKUP LOCATION IS NOT WRITABLE");
    }).catch(() => {
      if (active) setWarning("BACKUP SETTINGS COULD NOT BE OPENED");
    });
    return () => {
      active = false;
      restoreAbort.current?.abort();
    };
  }, [client]);

  useEffect(() => {
    onWarning?.(warning);
  }, [onWarning, warning]);

  useEffect(() => {
    if (fromDay) setExportFrom(fromDay);
    if (toDay) setExportTo(toDay);
  }, [fromDay, toDay]);

  async function saveLocation(candidate = pathValue): Promise<void> {
    setBusy(true);
    setStatus(undefined);
    try {
      const verified = await client.setBackupLocation(candidate);
      setSettings(verified);
      setPathValue(verified.backupRoot);
      setWarning(verified.writable ? undefined : "BACKUP LOCATION IS NOT WRITABLE");
      setStatus("BACKUP LOCATION VERIFIED");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setWarning(message.includes("UNSAFE")
        ? "BACKUP LOCATION IS NOT SAFE"
        : "BACKUP LOCATION IS NOT WRITABLE");
    } finally {
      setBusy(false);
    }
  }

  async function chooseLocation(): Promise<void> {
    const chosen = await window.diaryDesktop?.chooseBackupDirectory();
    if (!chosen) return;
    setPathValue(chosen);
    await saveLocation(chosen);
  }

  function chooseAnotherLocation(): void {
    if (window.diaryDesktop) {
      void chooseLocation();
    } else {
      pathInput.current?.focus();
      pathInput.current?.select();
    }
  }

  async function createSnapshot(download: boolean): Promise<void> {
    setBusy(true);
    setStatus(download ? "PREPARING COMPLETE ARCHIVE" : "CREATING SNAPSHOT");
    try {
      const snapshot = await client.createBackupSnapshot();
      if (download) triggerDownload(snapshot.archiveUrl);
      setStatus(download ? "COMPLETE ARCHIVE READY" : "SNAPSHOT COMPLETE");
    } catch {
      setWarning("BACKUP COULD NOT BE CREATED");
    } finally {
      setBusy(false);
    }
  }

  function exportMarkdown(): void {
    if (!exportFrom || !exportTo || exportFrom > exportTo) {
      setWarning("CHOOSE A VALID BEIJING DATE RANGE");
      return;
    }
    triggerDownload(client.markdownExportUrl(exportFrom, exportTo));
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
    <section className="management-page backup-settings" aria-labelledby="backup-settings-title">
      <header className="settings-heading">
        <p>LOCAL RECOVERY</p>
        <h1 id="backup-settings-title">BACKUP</h1>
      </header>

      {warning && !onWarning ? (
        <aside className="backup-warning" aria-live="polite">
          <p role="alert">{warning}</p>
          <button type="button" onClick={chooseAnotherLocation}>CHOOSE ANOTHER LOCATION</button>
        </aside>
      ) : null}

      <section className="settings-section" aria-labelledby="backup-location-title">
        <div className="settings-section-heading">
          <h2 id="backup-location-title">LOCATION</h2>
          <span>{window.diaryDesktop ? "DESKTOP DIRECTORY" : "LOCAL SERVER PATH"}</span>
        </div>
        <label className="settings-field">
          BACKUP FOLDER PATH
          <input
            ref={pathInput}
            aria-label="Backup folder path"
            value={pathValue}
            onChange={(event) => setPathValue(event.target.value)}
            spellCheck={false}
          />
        </label>
        <p className="settings-note">
          EXISTING BACKUPS STAY IN THEIR PREVIOUS LOCATION.
        </p>
        <div className="settings-actions">
          {window.diaryDesktop ? (
            <button type="button" aria-label="Choose backup location" disabled={busy} onClick={() => void chooseLocation()}>
              CHOOSE LOCATION
            </button>
          ) : null}
          <button type="button" aria-label="Save backup location" disabled={busy || !pathValue.trim()} onClick={() => void saveLocation()}>
            SAVE LOCATION
          </button>
        </div>
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
          <button type="button" aria-label="Export portable Markdown" disabled={busy || !exportFrom || !exportTo} onClick={exportMarkdown}>
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
    </section>
  );
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
