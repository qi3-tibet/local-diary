import { useEffect, useRef } from "react";

export type DiaryDesktopBridge = {
  chooseBackupDirectory(): Promise<string | null>;
  onFlushBeforeClose?(listener: () => Promise<boolean>): () => void;
};

declare global {
  interface Window {
    diaryDesktop?: DiaryDesktopBridge;
  }
}

export function useFlushBeforeClose(listener: () => Promise<boolean>): void {
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  useEffect(() => {
    return window.diaryDesktop?.onFlushBeforeClose?.(() => listenerRef.current());
  }, []);
}
