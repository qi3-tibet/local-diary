import { contextBridge, ipcRenderer } from "electron";

const BACKUP_DIRECTORY_CHANNEL = "diary:choose-backup-directory";
const FLUSH_BEFORE_CLOSE_CHANNEL = "diary:flush-before-close";
const FLUSH_BEFORE_CLOSE_RESULT_CHANNEL = "diary:flush-before-close:result";

contextBridge.exposeInMainWorld("diaryDesktop", Object.freeze({
  chooseBackupDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(BACKUP_DIRECTORY_CHANNEL) as Promise<string | null>,
  onFlushBeforeClose: (listener: () => Promise<boolean>): (() => void) => {
    const handleFlush = (_event: unknown, requestId: number) => {
      void Promise.resolve()
        .then(() => listener())
        .then(
          (ok) => ipcRenderer.send(FLUSH_BEFORE_CLOSE_RESULT_CHANNEL, { ok: ok === true, requestId }),
          () => ipcRenderer.send(FLUSH_BEFORE_CLOSE_RESULT_CHANNEL, { ok: false, requestId }),
        );
    };
    ipcRenderer.on(FLUSH_BEFORE_CLOSE_CHANNEL, handleFlush);
    return () => ipcRenderer.removeListener(FLUSH_BEFORE_CLOSE_CHANNEL, handleFlush);
  },
}));
