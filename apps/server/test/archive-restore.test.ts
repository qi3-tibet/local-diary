import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotService } from "../src/backup/snapshot.js";
import { exportArchive } from "../src/backup/archive.js";
import { restoreArchive } from "../src/backup/restore.js";
import { createDiaryDatabase, type DiaryDatabase } from "../src/db/client.js";
import { MediaStore } from "../src/media/store.js";

describe("complete archive restore", () => {
  const roots: string[] = [];
  const databases: DiaryDatabase[] = [];
  afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it("round-trips a standalone archive with database and original media bytes", async () => {
    const dataRoot = temp("archive-data-");
    const backupRoot = temp("archive-backup-");
    const database = createDiaryDatabase(dataRoot);
    databases.push(database);
    const media = new MediaStore(join(dataRoot, "media"));
    const image = await media.put(Buffer.from("image bytes"), "jpg");
    const music = await media.put(Buffer.from("music bytes"), "mp3");
    const snapshots = new SnapshotService({ dataRoot, backupRoot, database });
    const snapshot = await snapshots.create("2026-07-26");
    const archive = join(temp("archive-output-"), "diary.zip");

    await exportArchive(snapshot.id, snapshots, archive);
    const restoreRoot = temp("archive-restore-");
    await restoreArchive(archive, { dataRoot: restoreRoot, temporaryRoot: temp("archive-temp-") });

    expect(await readFile(join(restoreRoot, "media", "objects", image.hash.slice(0, 2), `${image.hash}.jpg`))).toEqual(Buffer.from("image bytes"));
    expect(await readFile(join(restoreRoot, "media", "objects", music.hash.slice(0, 2), `${music.hash}.mp3`))).toEqual(Buffer.from("music bytes"));
    const restored = createDiaryDatabase(restoreRoot);
    databases.push(restored);
    expect(restored.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 0 });
  });

  it("does not modify live data when an archive checksum is corrupt", async () => {
    const dataRoot = temp("archive-live-");
    const backupRoot = temp("archive-backup-");
    const database = createDiaryDatabase(dataRoot);
    databases.push(database);
    const snapshots = new SnapshotService({ dataRoot, backupRoot, database });
    const snapshot = await snapshots.create("2026-07-26");
    const archive = join(temp("archive-output-"), "diary.zip");
    await exportArchive(snapshot.id, snapshots, archive);
    await writeFile(archive, Buffer.concat([(await readFile(archive)).subarray(0, 50), Buffer.from("corrupt")]));
    const before = await readFile(join(dataRoot, "diary.sqlite"));

    await expect(restoreArchive(archive, { dataRoot, temporaryRoot: temp("archive-temp-") })).rejects.toThrow();
    expect(await readFile(join(dataRoot, "diary.sqlite"))).toEqual(before);
  });

  it("requires a safety snapshot before replacing an existing diary", async () => {
    const dataRoot = temp("archive-live-");
    const backupRoot = temp("archive-backup-");
    const database = createDiaryDatabase(dataRoot); databases.push(database);
    const snapshots = new SnapshotService({ dataRoot, backupRoot, database });
    const snapshot = await snapshots.create("2026-07-26");
    const archive = join(temp("archive-output-"), "diary.zip");
    await exportArchive(snapshot.id, snapshots, archive);
    const before = await readFile(join(dataRoot, "diary.sqlite"));
    await expect(restoreArchive(archive, { dataRoot, temporaryRoot: temp("archive-temp-"), quiesce: async () => {} }))
      .rejects.toThrow("RESTORE_SAFETY_SNAPSHOT_REQUIRED");
    expect(await readFile(join(dataRoot, "diary.sqlite"))).toEqual(before);
  });

  function temp(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
});
