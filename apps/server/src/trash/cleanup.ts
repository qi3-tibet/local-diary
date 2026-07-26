import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EntryRepository } from "../entries/repository.js";
import type { MediaStore } from "../media/store.js";

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function purgeExpiredTrash(repository: EntryRepository, now: Date): number {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_MS).toISOString();
  return repository.purgeTrashedBefore(cutoff);
}

export type TrashCleanupResult = {
  purgedEntries: number;
  removedObjects: number;
  failures: number;
};

type CleanupRecord = {
  event: "trash-cleanup-complete" | "trash-cleanup-failed";
  at: string;
  purgedEntries?: number;
  removedObjects?: number;
  failures?: number;
  error?: string;
};

export type CleanupLogger = (record: CleanupRecord) => Promise<void>;

export function createFileCleanupLogger(pathname: string): CleanupLogger {
  return async (record) => {
    await mkdir(dirname(pathname), { recursive: true });
    await appendFile(pathname, `${JSON.stringify(record)}\n`, "utf8");
  };
}

export async function runTrashCleanup(options: {
  repository: EntryRepository;
  mediaStore: MediaStore;
  now: Date;
  logger?: CleanupLogger;
}): Promise<TrashCleanupResult> {
  const cutoff = new Date(options.now.getTime() - TRASH_RETENTION_MS).toISOString();
  let purged;
  let pending;
  try {
    purged = options.repository.purgeTrashedBeforeWithMedia(cutoff);
    pending = options.repository.listPendingMediaObjectCleanup();
  } catch (error) {
    await safeLog(options.logger, {
      event: "trash-cleanup-failed",
      at: options.now.toISOString(),
      error: errorCode(error),
    });
    throw error;
  }

  let removedObjects = 0;
  let failures = 0;
  await options.mediaStore.withObjectLocks(
    pending.map(({ hash }) => hash),
    async () => {
      for (const object of pending) {
        if (options.repository.isMediaObjectReferenced(object)) {
          options.repository.completeMediaObjectCleanup(object);
          continue;
        }
        try {
          await options.mediaStore.remove(
            options.mediaStore.pathFor(object.hash, object.extension),
          );
          options.repository.completeMediaObjectCleanup(object);
          removedObjects += 1;
        } catch {
          failures += 1;
        }
      }
    },
  );

  const result = {
    purgedEntries: purged.purgedEntries,
    removedObjects,
    failures,
  };
  await safeLog(options.logger, {
    event: "trash-cleanup-complete",
    at: options.now.toISOString(),
    ...result,
  });
  return result;
}

export function startTrashCleanupScheduler(options: {
  cleanup: () => Promise<unknown>;
  now?: () => Date;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): { startup: Promise<void>; stop(): Promise<void> } {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer
    ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = options.clearTimer
    ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  let stopped = false;
  let timer: unknown;
  let currentRun: Promise<void> | undefined;

  const schedule = () => {
    if (stopped) return;
    timer = setTimer(() => {
      timer = undefined;
      currentRun = run();
    }, millisecondsUntilNextBeijingDay(now()));
    (timer as { unref?: () => void })?.unref?.();
  };
  const run = async () => {
    try {
      await options.cleanup();
    } catch {
      // The cleanup operation records its own failure. Continue scheduling so
      // a transient filesystem/database error can recover on the next day.
    } finally {
      schedule();
    }
  };
  currentRun = run();
  const startup = currentRun;

  return {
    startup,
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      await currentRun;
    },
  };
}

export function millisecondsUntilNextBeijingDay(now: Date): number {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const next = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
  );
  return Math.max(1, next - shifted.getTime());
}

async function safeLog(logger: CleanupLogger | undefined, record: CleanupRecord): Promise<void> {
  try {
    await logger?.(record);
  } catch {
    // Logging must never change the cleanup outcome.
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
    ? code
    : "CLEANUP_FAILED";
}
