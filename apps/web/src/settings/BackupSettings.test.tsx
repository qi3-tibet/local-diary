// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupSettings } from "./BackupSettings";

afterEach(() => {
  delete window.diaryDesktop;
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
    restoreBackup: vi.fn(async (_file: File, onEvent: (event: { phase: string }) => void) => {
      ["VALIDATING", "SAFETY_BACKUP", "RESTORING", "REBUILDING", "DONE"]
        .forEach((phase) => onEvent({ phase }));
    }),
    markdownExportUrl: vi.fn((from: string, to: string) => `/export?from=${from}&to=${to}`),
    ...overrides,
  };
}

describe("BackupSettings", () => {
  it("uses an explicit server path in a plain browser and remembers it only after verification", async () => {
    const api = client();
    render(<BackupSettings client={api} fromDay="2026-07-26" toDay="2026-07-26" />);
    const input = await screen.findByLabelText("Backup folder path");
    expect(input).toHaveValue("C:\\Users\\me\\Documents\\Diary Backups");
    expect(screen.getByText("LOCAL SERVER PATH")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "D:\\Private Diary Backups" } });
    screen.getByRole("button", { name: "Save backup location" }).click();

    await waitFor(() => expect(api.setBackupLocation).toHaveBeenCalledWith("D:\\Private Diary Backups"));
    expect(screen.getByText("BACKUP LOCATION VERIFIED")).toBeInTheDocument();
  });

  it("keeps an unwritable warning visible and leaves recovery available", async () => {
    const api = client({
      setBackupLocation: vi.fn(async () => {
        throw new Error("BACKUP_LOCATION_NOT_WRITABLE");
      }),
    });
    render(<BackupSettings client={api} fromDay="2026-07-26" toDay="2026-07-26" />);
    await screen.findByLabelText("Backup folder path");

    screen.getByRole("button", { name: "Save backup location" }).click();

    expect(await screen.findByText("BACKUP LOCATION IS NOT WRITABLE")).toBeVisible();
    expect(screen.getByRole("button", { name: "CHOOSE ANOTHER LOCATION" })).toBeEnabled();
  });

  it("uses the typed desktop bridge for a real filesystem path when available", async () => {
    window.diaryDesktop = {
      chooseBackupDirectory: vi.fn(async () => "D:\\Selected by desktop"),
    };
    const api = client();
    render(<BackupSettings client={api} fromDay="2026-07-26" toDay="2026-07-26" />);
    await screen.findByLabelText("Backup folder path");

    screen.getByRole("button", { name: "Choose backup location" }).click();

    await waitFor(() => expect(api.setBackupLocation).toHaveBeenCalledWith("D:\\Selected by desktop"));
  });

  it("streams restore progress, retains the file for retry, and reports completion", async () => {
    const onRestoreState = vi.fn();
    const onRestored = vi.fn();
    const api = client();
    render(
      <BackupSettings
        client={api}
        fromDay="2026-07-26"
        toDay="2026-07-26"
        onRestoreState={onRestoreState}
        onRestored={onRestored}
      />,
    );
    await screen.findByLabelText("Backup folder path");
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
