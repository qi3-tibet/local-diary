import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export const BACKUP_DIRECTORY_CHANNEL = "diary:choose-backup-directory";

type BridgeRuntime = {
  ipcMain: {
    handle(channel: string, handler: () => Promise<string | null>): void;
    removeHandler(channel: string): void;
  };
  dialog: {
    showOpenDialog(options: {
      title: string;
      properties: Array<"openDirectory" | "createDirectory">;
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
  };
};

export function registerBackupDirectoryBridge(runtime: BridgeRuntime): () => void {
  runtime.ipcMain.handle(BACKUP_DIRECTORY_CHANNEL, async () => {
    const selection = await runtime.dialog.showOpenDialog({
      title: "Choose backup directory",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || selection.filePaths.length === 0) return null;
    return canonicalDirectory(selection.filePaths[0]!);
  });
  return () => runtime.ipcMain.removeHandler(BACKUP_DIRECTORY_CHANNEL);
}

async function canonicalDirectory(selected: string): Promise<string> {
  if (!path.isAbsolute(selected)) throw invalidDirectory();
  try {
    const canonical = await realpath(path.resolve(selected));
    const details = await stat(canonical);
    if (!details.isDirectory() || path.parse(canonical).root === canonical) {
      throw invalidDirectory();
    }
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message === "BACKUP_DIRECTORY_INVALID") throw error;
    throw invalidDirectory();
  }
}

function invalidDirectory(): Error {
  return new Error("BACKUP_DIRECTORY_INVALID");
}
