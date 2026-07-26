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
  restoreContext?: () => RestoreContext | null;
};

export function buildServer(options: ServerOptions = {}) {
  const server = Fastify({ logger: false });
  const dataRoot = path.resolve(options.dataRoot ?? "data");
  const clock = options.clock ?? createBeijingClock();
  const backupRoot = path.resolve(options.backupRoot ?? `${dataRoot}.backups`);
  const restoreTemporaryRoot = `${dataRoot}.restore-tmp`;
  let database = options.database ?? createDiaryDatabase(dataRoot);
  let mediaStore = new MediaStore(path.join(dataRoot, "media"));
  let entries = new EntryRepository(database, mediaStore);
  let service = new EntryService(entries, clock);
  let images = new ImageService(database, mediaStore);
  let music = new MusicService(database, mediaStore);
  let recognition = new MusicRecognitionService(database, mediaStore, options.musicRecognition?.textLookup ?? createMusicBrainzTextLookup(), options.musicRecognition?.fingerprintLookup ?? createAcoustIdFingerprintLookup());
  let snapshots = new SnapshotService({ dataRoot, backupRoot, database });
  const rebuild = () => { database = createDiaryDatabase(dataRoot); mediaStore = new MediaStore(path.join(dataRoot, "media")); entries = new EntryRepository(database, mediaStore); service = new EntryService(entries, clock); images = new ImageService(database, mediaStore); music = new MusicService(database, mediaStore); recognition = new MusicRecognitionService(database, mediaStore, options.musicRecognition?.textLookup ?? createMusicBrainzTextLookup(), options.musicRecognition?.fingerprintLookup ?? createAcoustIdFingerprintLookup()); snapshots = new SnapshotService({ dataRoot, backupRoot, database }); };
  let blocked = false; let active = 0; let drained!: () => void; let drain = Promise.resolve();
  server.addHook("onRequest", async (request, reply) => { if (request.url.startsWith("/api/v1/backups/restore")) return; if (blocked) return reply.code(503).send({ error: "RESTORE_IN_PROGRESS" }); (request as { restoreGate?: boolean }).restoreGate = true; active += 1; });
  server.addHook("onResponse", async (request) => { if (!(request as { restoreGate?: boolean }).restoreGate) return; active -= 1; if (active === 0) drained?.(); });
  const defaultRestoreContext = () => ({ dataRoot, temporaryRoot: restoreTemporaryRoot, coordinator: {
    acquireBarrier: async () => { blocked = true; if (active > 0) { drain = new Promise<void>((resolvePromise) => { drained = resolvePromise; }); await drain; } return () => { blocked = false; }; },
    createSafetySnapshot: async () => { await snapshots.create(clock.dayKey(clock.publishedAt())); },
    quiesce: async () => { database.close(); }, reopen: async () => { rebuild(); }, rebuildDerivedData: async () => {},
  } });

  server.get("/api/v1/health", async () => ({ status: "ok", apiVersion: 1 }));
  void server.register(multipart);
  void registerEntryRoutes(server, () => service, () => entries);
  void registerSearchRoutes(server, () => entries);
  void registerMediaRoutes(server, () => images);
  void registerMusicRoutes(server, () => music, () => recognition, options.musicUploadLimit);
  void registerMusicStreamRoute(server, () => database, () => mediaStore);
  registerBackupRoutes(server, { snapshots: () => snapshots, temporaryRoot: restoreTemporaryRoot, restoreContext: options.restoreContext ?? defaultRestoreContext });
  server.addHook("onClose", async () => database.close());

  return server;
}
