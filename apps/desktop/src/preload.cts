import { contextBridge, ipcRenderer } from "electron";

const BACKUP_DIRECTORY_CHANNEL = "diary:choose-backup-directory";

contextBridge.exposeInMainWorld("diaryDesktop", Object.freeze({
  chooseBackupDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(BACKUP_DIRECTORY_CHANNEL) as Promise<string | null>,
}));
