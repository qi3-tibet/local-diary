// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupSettings } from "./BackupSettings";
import type {
  DiaryDirectoryHandle,
  DirectoryHandleStore,
} from "./directory-handle-store";

afterEach(() => {
  delete window.diaryDesktop;
  delete window.showDirectoryPicker;
  cleanup();
});

function client(overrides: Record<string, unknown> = {}) {
  return {
    getBackupSettings: vi.fn(async () => ({
      backupRoot: "C:\\Users\\me\\Documents\\Diary Backups",
      writable: true,
      existingBackups: "left-in-previous-location" as const,
      selectionMode: "server-path" as const,
    })),
    setBackupLocation: vi.fn(async (backupRoot: string) => ({
      backupRoot,
      writable: true,
      existingBackups: "left-in-previous-location" as const,
      selectionMode: "server-path" as const,
    })),
    createBackupSnapshot: vi.fn(async () => ({
      snapshotId: "snapshot-1",
      archiveUrl: "/api/v1/backups/snapshot-1/archive",
    })),
    fetchDownload: vi.fn(async () => new Blob(["archive"], { type: "application/zip" })),
    restoreBackup: vi.fn(async (_file: File, onEvent: (event: { phase: string }) => void) => {
      ["VALIDATING", "SAFETY_BACKUP", "RESTORING", "REBUILDING", "DONE"]
        .forEach((phase) => onEvent({ phase }));
    }),
    markdownExportUrl: vi.fn((from: string, to: string) => `/export?from=${from}&to=${to}`),
    ...overrides,
  };
}

function memoryStore(initial: DiaryDirectoryHandle | null = null): DirectoryHandleStore & {
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  return {
    load: vi.fn(async () => current),
    save: vi.fn(async (handle: DiaryDirectoryHandle) => { current = handle; }),
    clear: vi.fn(async () => { current = null; }),
  };
}

function directory(name = "Private exports") {
  const writable = {
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const fileHandle = { createWritable: vi.fn(async () => writable) };
  const handle: DiaryDirectoryHandle = {
    kind: "directory",
    name,
    queryPermission: vi.fn(async () => "granted" as PermissionState),
    requestPermission: vi.fn(async () => "granted" as PermissionState),
    getFileHandle: vi.fn(async () => fileHandle),
  };
  return { handle, fileHandle, writable };
}

describe("BackupSettings", () => {
  it("shows the server-managed automatic location without exposing an editable path", async () => {
    const api = client();
    render(<BackupSettings client={api} handleStore={memoryStore()} fromDay="2026-07-26" toDay="2026-07-26" />);

    expect(await screen.findByLabelText("Automatic backup location")).toHaveTextContent(
      "C:\\Users\\me\\Documents\\Diary Backups",
    );
    expect(screen.queryByLabelText("Backup folder path")).not.toBeInTheDocument();
    expect(screen.getByText("DESKTOP APP REQUIRED TO CHANGE AUTOMATIC BACKUP LOCATION")).toBeVisible();
    expect(screen.getByRole("button", { name: "Choose backup location" })).toBeDisabled();
  });

  it("sends only an absolute path returned by the typed desktop bridge for server verification", async () => {
    window.diaryDesktop = {
      chooseBackupDirectory: vi.fn(async () => "D:\\Selected by desktop"),
    };
    const api = client();
    render(<BackupSettings client={api} handleStore={memoryStore()} fromDay="2026-07-26" toDay="2026-07-26" />);
    await screen.findByLabelText("Automatic backup location");

    screen.getByRole("button", { name: "Choose backup location" }).click();

    await waitFor(() => expect(api.setBackupLocation).toHaveBeenCalledWith("D:\\Selected by desktop"));
    expect(screen.getByText("BACKUP LOCATION VERIFIED")).toBeVisible();
  });

  it("retains a browser directory handle for manual exports and never sends its name to the server", async () => {
    const picked = directory("Browser vault");
    const store = memoryStore();
    window.showDirectoryPicker = vi.fn(async () => picked.handle);
    const api = client();
    render(<BackupSettings client={api} handleStore={store} fromDay="2026-07-26" toDay="2026-07-26" />);
    await screen.findByLabelText("Automatic backup location");

    screen.getByRole("button", { name: "Choose backup location" }).click();

    await screen.findByText("BROWSER EXPORT FOLDER · Browser vault");
    expect(store.save).toHaveBeenCalledWith(picked.handle);
    expect(api.setBackupLocation).not.toHaveBeenCalled();
  });

  it("restores a persisted handle after read-write permission is granted", async () => {
    const persisted = directory("Remembered exports");
    const store = memoryStore(persisted.handle);
    window.showDirectoryPicker = vi.fn();

    render(<BackupSettings client={client()} handleStore={store} fromDay="2026-07-26" toDay="2026-07-26" />);

    expect(await screen.findByText("BROWSER EXPORT FOLDER · Remembered exports")).toBeVisible();
    expect(persisted.handle.queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
  });

  it("writes complete and Markdown archives through the selected browser handle", async () => {
    const picked = directory("Exports");
    window.showDirectoryPicker = vi.fn(async () => picked.handle);
    const api = client();
    render(<BackupSettings client={api} handleStore={memoryStore()} fromDay="2026-07-26" toDay="2026-07-26" />);
    await screen.findByLabelText("Automatic backup location");
    screen.getByRole("button", { name: "Choose backup location" }).click();
    await screen.findByText("BROWSER EXPORT FOLDER · Exports");

    screen.getByRole("button", { name: "Export complete archive" }).click();
    await waitFor(() => expect(picked.handle.getFileHandle).toHaveBeenCalledWith(
      "diary-snapshot-1.zip",
      { create: true },
    ));
    expect(picked.writable.write).toHaveBeenCalledWith(expect.any(Blob));
    expect(picked.writable.close).toHaveBeenCalled();

    screen.getByRole("button", { name: "Export portable Markdown" }).click();
    await waitFor(() => expect(picked.handle.getFileHandle).toHaveBeenCalledWith(
      "diary-2026-07-26-to-2026-07-26.zip",
      { create: true },
    ));
    expect(api.fetchDownload).toHaveBeenCalledWith("/export?from=2026-07-26&to=2026-07-26");
  });

  it("streams restore progress, retains the file for retry, and reports completion", async () => {
    const onRestoreState = vi.fn();
    const onRestored = vi.fn();
    const api = client();
    render(
      <BackupSettings
        client={api}
        handleStore={memoryStore()}
        fromDay="2026-07-26"
        toDay="2026-07-26"
        onRestoreState={onRestoreState}
        onRestored={onRestored}
      />,
    );
    await screen.findByLabelText("Automatic backup location");
    const archive = new File(["zip"], "diary.zip", { type: "application/zip" });

    fireEvent.change(screen.getByLabelText("Restore complete archive"), {
      target: { files: [archive] },
    });

    await waitFor(() => expect(onRestored).toHaveBeenCalledOnce());
    expect(api.restoreBackup).toHaveBeenCalledWith(archive, expect.any(Function), expect.any(AbortSignal));
    expect(onRestoreState).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "DONE",
      history: ["VALIDATING", "SAFETY_BACKUP", "RESTORING", "REBUILDING", "DONE"],
    }));
  });
});
