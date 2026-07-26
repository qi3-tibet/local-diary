import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKUP_DIRECTORY_CHANNEL,
  registerBackupDirectoryBridge,
} from "../src/backup-directory-bridge.js";

describe("desktop backup directory bridge", () => {
  const roots: string[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it("registers one narrow chooser handler and returns a canonical absolute directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "local-diary-bridge-"));
    roots.push(root);
    await mkdir(path.join(root, "nested"));
    let handler!: () => Promise<string | null>;
    const runtime = {
      ipcMain: {
        handle: vi.fn((channel: string, value: () => Promise<string | null>) => {
          expect(channel).toBe(BACKUP_DIRECTORY_CHANNEL);
          handler = value;
        }),
        removeHandler: vi.fn(),
      },
      dialog: {
        showOpenDialog: vi.fn(async () => ({
          canceled: false,
          filePaths: [path.join(root, "nested", "..")],
        })),
      },
    };

    const dispose = registerBackupDirectoryBridge(runtime);

    await expect(handler()).resolves.toBe(await realpath(root));
    expect(runtime.dialog.showOpenDialog).toHaveBeenCalledWith({
      title: "Choose backup directory",
      properties: ["openDirectory", "createDirectory"],
    });
    dispose();
    expect(runtime.ipcMain.removeHandler).toHaveBeenCalledWith(BACKUP_DIRECTORY_CHANNEL);
  });

  it("returns null on cancellation and rejects files or non-absolute selections", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "local-diary-bridge-"));
    roots.push(root);
    const file = path.join(root, "not-a-directory.txt");
    writeFileSync(file, "not a directory");
    let handler!: () => Promise<string | null>;
    const dialog = {
      showOpenDialog: vi.fn()
        .mockResolvedValueOnce({ canceled: true, filePaths: [] })
        .mockResolvedValueOnce({ canceled: false, filePaths: [file] })
        .mockResolvedValueOnce({ canceled: false, filePaths: ["relative"] }),
    };
    registerBackupDirectoryBridge({
      ipcMain: {
        handle: (_channel, value) => { handler = value; },
        removeHandler: () => undefined,
      },
      dialog,
    });

    await expect(handler()).resolves.toBeNull();
    await expect(handler()).rejects.toThrow("BACKUP_DIRECTORY_INVALID");
    await expect(handler()).rejects.toThrow("BACKUP_DIRECTORY_INVALID");
  });
});
