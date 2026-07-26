import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { createDiaryDatabase, type DiaryDatabase } from "./db/client.js";
import { EntryRepository } from "./entries/repository.js";
import { registerEntryRoutes } from "./entries/routes.js";
import { EntryService } from "./entries/service.js";
import { registerSearchRoutes } from "./search/routes.js";
import { createBeijingClock, type BeijingClock } from "./time/beijing.js";
import { ImageService } from "./media/images.js";
import { registerMediaRoutes } from "./media/routes.js";
import { MediaStore } from "./media/store.js";
import { registerMusicStreamRoute } from "./media/stream-route.js";
import { MusicService } from "./music/service.js";
import { registerMusicRoutes } from "./music/routes.js";
import { createAcoustIdFingerprintLookup } from "./music/recognition/fingerprint.js";
import { MusicRecognitionService } from "./music/recognition/service.js";
import { createMusicBrainzTextLookup } from "./music/recognition/text-lookup.js";
import type { FingerprintLookup, TextLookup } from "./music/recognition/types.js";
import path from "node:path";
import { SnapshotService } from "./backup/snapshot.js";
import { registerBackupRoutes } from "./backup/routes.js";
import type { RestoreContext } from "./backup/restore.js";
import { registerMarkdownExportRoutes } from "./export/routes.js";
import { BackupSettingsRepository } from "./settings/repository.js";
import { registerSettingsRoutes } from "./settings/routes.js";
import { runDailyBackupIfDue } from "./backup/scheduler.js";
import { registerLoopbackRequestSecurity } from "./security/loopback-request.js";
import {
  createFileCleanupLogger,
  runTrashCleanup,
  startTrashCleanupScheduler,
} from "./trash/cleanup.js";

export type ServerOptions = {
  dataRoot?: string;
  database?: DiaryDatabase;
  clock?: BeijingClock;
  musicUploadLimit?: number;
  musicRecognition?: {
    textLookup?: TextLookup;
    fingerprintLookup?: FingerprintLookup;
  };
  backupRoot?: string;
  settingsPath?: string;
  scheduleBackups?: boolean;
  restoreContext?: () => RestoreContext | null;
  restoreUploadLimit?: number;
  logRoot?: string;
  scheduleTrashCleanup?: boolean;
  trashCleanupSchedulerFactory?: typeof startTrashCleanupScheduler;
};

export function buildServer(options: ServerOptions = {}) {
  const server = Fastify({ logger: false });
  registerLoopbackRequestSecurity(server);
  const dataRoot = path.resolve(options.dataRoot ?? "data");
  const clock = options.clock ?? createBeijingClock();
  const defaultBackupRoot = path.resolve(options.backupRoot ?? `${dataRoot}.backups`);
  const settings = new BackupSettingsRepository({
    dataRoot,
    settingsPath: options.settingsPath ?? `${dataRoot}.settings/backup.json`,
    defaultBackupRoot,
  });
  let backupRoot = settings.currentBackupRoot();
  const restoreTemporaryRoot = `${dataRoot}.restore-tmp`;
  const cleanupLogger = createFileCleanupLogger(
    path.join(path.resolve(options.logRoot ?? `${dataRoot}.logs`), "cleanup.ndjson"),
  );
  let database = options.database ?? createDiaryDatabase(dataRoot);
  let mediaStore = new MediaStore(path.join(dataRoot, "media"));
  let entries = new EntryRepository(database, mediaStore);
  let service = new EntryService(entries, clock);
  let images = new ImageService(database, mediaStore);
  let music = new MusicService(database, mediaStore);
  let recognition = new MusicRecognitionService(database, mediaStore, options.musicRecognition?.textLookup ?? createMusicBrainzTextLookup(), options.musicRecognition?.fingerprintLookup ?? createAcoustIdFingerprintLookup());
  let snapshots = new SnapshotService({ dataRoot, backupRoot, database });
  const rebuild = () => { database = createDiaryDatabase(dataRoot); mediaStore = new MediaStore(path.join(dataRoot, "media")); entries = new EntryRepository(database, mediaStore); service = new EntryService(entries, clock); images = new ImageService(database, mediaStore); music = new MusicService(database, mediaStore); recognition = new MusicRecognitionService(database, mediaStore, options.musicRecognition?.textLookup ?? createMusicBrainzTextLookup(), options.musicRecognition?.fingerprintLookup ?? createAcoustIdFingerprintLookup()); snapshots = new SnapshotService({ dataRoot, backupRoot, database }); };
  const trashCleanupEnabled = options.scheduleTrashCleanup
    ?? (process.env.NODE_ENV !== "test" && !options.database);
  const createTrashScheduler = options.trashCleanupSchedulerFactory
    ?? startTrashCleanupScheduler;
  let trashScheduler: ReturnType<typeof startTrashCleanupScheduler> | undefined;
  let closing = false;
  const startTrashScheduler = async () => {
    if (!trashCleanupEnabled || closing || trashScheduler) return;
    trashScheduler = createTrashScheduler({
      cleanup: () => runTrashCleanup({
        repository: entries,
        mediaStore,
        now: new Date(),
        logger: cleanupLogger,
      }),
    });
    await trashScheduler.startup;
  };
  const stopTrashScheduler = async () => {
    const scheduler = trashScheduler;
    trashScheduler = undefined;
    await scheduler?.stop();
  };
  let blocked = false; let active = 0; let drained!: () => void; let drain = Promise.resolve();
  server.addHook("onRequest", async (request, reply) => { if (request.url.startsWith("/api/v1/backups/restore")) return; if (blocked) return reply.code(503).send({ error: "RESTORE_IN_PROGRESS" }); (request as { restoreGate?: boolean }).restoreGate = true; active += 1; });
  server.addHook("onResponse", async (request) => { if (!(request as { restoreGate?: boolean }).restoreGate) return; active -= 1; if (active === 0) drained?.(); });
  const defaultRestoreContext = () => ({ dataRoot, temporaryRoot: restoreTemporaryRoot, coordinator: {
    acquireBarrier: async () => {
      blocked = true;
      try {
        await stopTrashScheduler();
        if (active > 0) {
          drain = new Promise<void>((resolvePromise) => {
            drained = resolvePromise;
          });
          await drain;
        }
      } catch (error) {
        blocked = false;
        await startTrashScheduler();
        throw error;
      }
      return async () => {
        blocked = false;
        await startTrashScheduler();
      };
    },
    createSafetySnapshot: async () => (await snapshots.createSafetySnapshot(clock.dayKey(clock.publishedAt()))).id,
    quiesce: async () => { database.close(); }, reopen: async () => { rebuild(); }, rebuildDerivedData: async () => {},
  } });

  server.get("/api/v1/health", async () => ({ status: "ok", apiVersion: 1 }));
  void server.register(multipart);
  void registerEntryRoutes(server, () => service, () => entries);
  void registerSearchRoutes(server, () => entries);
  void registerMediaRoutes(server, () => images);
  void registerMusicRoutes(server, () => music, () => recognition, options.musicUploadLimit);
  void registerMusicStreamRoute(server, () => database, () => mediaStore);
  registerBackupRoutes(server, {
    snapshots: () => snapshots,
    temporaryRoot: restoreTemporaryRoot,
    restoreContext: options.restoreContext ?? defaultRestoreContext,
    restoreUploadLimit: options.restoreUploadLimit,
  });
  registerMarkdownExportRoutes(server, {
    database: () => database,
    mediaStore: () => mediaStore,
    temporaryRoot: restoreTemporaryRoot,
  });
  registerSettingsRoutes(server, {
    repository: settings,
    snapshots: () => snapshots,
    day: () => clock.dayKey(clock.publishedAt()),
    onBackupRootChanged: async (nextRoot) => {
      if (backupRoot === nextRoot) return;
      backupRoot = nextRoot;
      snapshots = new SnapshotService({ dataRoot, backupRoot, database });
      await runDailyBackupIfDue({ snapshots, clock });
    },
  });
  let dailyTimer: ReturnType<typeof setInterval> | undefined;
  server.addHook("onReady", async () => {
    const current = await settings.get();
    if (current.writable) {
      backupRoot = current.backupRoot;
      snapshots = new SnapshotService({ dataRoot, backupRoot, database });
      if (options.scheduleBackups ?? (process.env.NODE_ENV !== "test" && !options.database)) {
        await runDailyBackupIfDue({ snapshots, clock });
      }
    }
    if (options.scheduleBackups ?? (process.env.NODE_ENV !== "test" && !options.database)) {
      dailyTimer = setInterval(() => {
        void runDailyBackupIfDue({ snapshots, clock });
      }, 60 * 60 * 1000);
      dailyTimer.unref();
    }
    await startTrashScheduler();
  });
  server.addHook("onClose", async () => {
    closing = true;
    if (dailyTimer) clearInterval(dailyTimer);
    await stopTrashScheduler();
    database.close();
  });

  return server;
}
