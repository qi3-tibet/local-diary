import type { FastifyInstance } from "fastify";
import type { SnapshotInfo, SnapshotService } from "../backup/snapshot.js";
import {
  BackupLocationError,
  type BackupSettingsRepository,
} from "./repository.js";

export function registerSettingsRoutes(server: FastifyInstance, options: {
  repository: BackupSettingsRepository;
  snapshots: () => SnapshotService;
  day: () => string;
  onBackupRootChanged: (backupRoot: string) => Promise<void>;
}): void {
  server.get("/api/v1/settings/backup", async () => options.repository.get());

  server.put("/api/v1/settings/backup", async (request, reply) => {
    const input = request.body as { backupRoot?: unknown } | null;
    if (!input || typeof input.backupRoot !== "string") {
      return reply.code(400).send({ error: "BACKUP_LOCATION_REQUIRED" });
    }
    try {
      const settings = await options.repository.setBackupRoot(input.backupRoot);
      await options.onBackupRootChanged(settings.backupRoot);
      return settings;
    } catch (error) {
      if (error instanceof BackupLocationError) {
        return reply.code(422).send({
          error: error.code,
          recovery: "CHOOSE ANOTHER LOCATION",
        });
      }
      throw error;
    }
  });

  server.post("/api/v1/backups/snapshot", async (_request, reply) => {
    const snapshot: SnapshotInfo = await options.snapshots().createSafetySnapshot(options.day());
    return reply.code(201).send({
      snapshotId: snapshot.id,
      archiveUrl: `/api/v1/backups/${snapshot.id}/archive`,
    });
  });
}
