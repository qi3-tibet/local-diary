import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupObjectStore } from "../src/backup/object-store.js";
import { SnapshotService } from "../src/backup/snapshot.js";
import { runDailyBackupIfDue } from "../src/backup/scheduler.js";
import { createDiaryDatabase, type DiaryDatabase } from "../src/db/client.js";
import { MediaStore } from "../src/media/store.js";

describe("backup snapshots", () => {
  const roots: string[] = [];
  const databases: DiaryDatabase[] = [];

  afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  function fixture() {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-backup-data-"));
    const backupRoot = mkdtempSync(path.join(tmpdir(), "local-diary-backup-store-"));
    const database = createDiaryDatabase(dataRoot);
    roots.push(dataRoot, backupRoot);
    databases.push(database);
    return {
      dataRoot,
      backupRoot,
      database,
      objects: new BackupObjectStore(backupRoot),
      snapshots: new SnapshotService({ dataRoot, backupRoot, database }),
    };
  }

  it("creates independently restorable manifests without copying unchanged media twice", async () => {
    const { dataRoot, objects, snapshots, database } = fixture();
    const media = new MediaStore(path.join(dataRoot, "media"));
    const original = await media.put(Buffer.from("original image"), "jpg");
    const display = await media.put(Buffer.from("display image"), "webp");

    const first = await snapshots.create("2026-07-26");
    const objectCount = await objects.count();
    database.exec("CREATE TABLE changed_between_snapshots (value TEXT NOT NULL)");
    database.prepare("INSERT INTO changed_between_snapshots (value) VALUES (?)").run("changed");
    const second = await snapshots.create("2026-07-27");

    expect(await objects.count()).toBe(objectCount + 1);
    expect(first.objects).toEqual(expect.arrayContaining([original.hash, display.hash]));
    expect(second.objects).toEqual(expect.arrayContaining([original.hash, display.hash]));

    const restoreRoot = mkdtempSync(path.join(tmpdir(), "local-diary-backup-restore-"));
    const target = path.join(restoreRoot, "staging");
    roots.push(restoreRoot);
    await snapshots.restore(first.id, target);
    expect(await readFile(path.join(target, "media", "objects", original.hash.slice(0, 2), `${original.hash}.jpg`)))
      .toEqual(Buffer.from("original image"));
    const restored = createDiaryDatabase(target);
    expect(restored.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 0 });
    restored.close();
  });

  it("retains the newest 30 Beijing-day snapshots and garbage-collects only unreferenced objects", async () => {
    const { dataRoot, objects, snapshots, database } = fixture();
    const media = new MediaStore(path.join(dataRoot, "media"));
    await media.put(Buffer.from("shared image"), "jpg");
    database.exec("CREATE TABLE backup_probe (value TEXT NOT NULL)");

    for (let day = 1; day <= 31; day += 1) {
      database.prepare("INSERT INTO backup_probe (value) VALUES (?)").run(String(day));
      await snapshots.create(`2026-07-${String(day).padStart(2, "0")}`);
    }

    const retained = await snapshots.list();
    expect(retained).toHaveLength(30);
    expect(retained.at(0)?.day).toBe("2026-07-02");
    expect(retained.at(-1)?.day).toBe("2026-07-31");
    expect(await objects.count()).toBe(31);
  }, 15_000);

  it("creates one idempotent same-day snapshot across concurrent service instances", async () => {
    const { dataRoot, backupRoot, database, snapshots } = fixture();
    const secondService = new SnapshotService({ dataRoot, backupRoot, database });
    const [left, right] = await Promise.all([
      snapshots.create("2026-07-26"),
      secondService.create("2026-07-26"),
    ]);
    const later = await snapshots.create("2026-07-26");
    const retained = await snapshots.list();

    expect(left.id).toBe(right.id);
    expect(later.id).toBe(left.id);
    expect(retained).toHaveLength(1);
    expect(retained[0]?.id).toBe(left.id);
  });

  it("cleans only recognized interrupted backup database artifacts before a new run", async () => {
    const { backupRoot, snapshots } = fixture();
    const temporary = path.join(backupRoot, ".tmp");
    await mkdir(temporary, { recursive: true });
    const abandoned = path.join(temporary, "11111111-1111-4111-8111-111111111111.sqlite");
    writeFileSync(abandoned, "abandoned");
    writeFileSync(path.join(temporary, "keep.txt"), "keep");

    await snapshots.create("2026-07-26");

    expect(await readdir(temporary)).toEqual(["keep.txt"]);
  });

  it("preserves an unmarked UUID temporary directory even when it contains snapshot.sqlite", async () => {
    const { backupRoot, snapshots } = fixture();
    const run = path.join(backupRoot, ".tmp", "22222222-2222-4222-8222-222222222222");
    await mkdir(run, { recursive: true });
    writeFileSync(path.join(run, "snapshot.sqlite"), "unrelated");

    await snapshots.create("2026-07-26");

    expect(await readFile(path.join(run, "snapshot.sqlite"), "utf8")).toBe("unrelated");
  });

  it("never displaces an ownership-refreshed live lease while attempting stale takeover", async () => {
    const { backupRoot, dataRoot, database } = fixture();
    const locks = path.join(backupRoot, ".locks");
    const lock = path.join(locks, "snapshot-create.lock");
    await mkdir(lock, { recursive: true });
    const owner = path.join(lock, "owner.json");
    writeFileSync(owner, JSON.stringify({ token: "old", pid: 1, processStartNonce: "old-process", createdAt: "2026-01-01T00:00:00.000Z" }));
    await utimes(lock, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    const currentOwner = JSON.stringify({ token: "new", pid: 2, processStartNonce: "new-process", createdAt: "2026-07-26T00:00:00.000Z" });
    const snapshots = new SnapshotService({
      dataRoot,
      backupRoot,
      database,
      beforeLeaseStealClaim: async () => {
        writeFileSync(owner, currentOwner);
        await utimes(lock, new Date(), new Date());
      },
      isProcessAlive: (pid) => pid === 2,
      lockTimeoutMs: 100,
    });

    await expect(snapshots.create("2026-07-26")).rejects.toThrow("BACKUP_LOCK_TIMEOUT");

    const quarantines = (await readdir(locks)).filter((name) => name.startsWith("snapshot-create.lock.steal-"));
    expect(quarantines).toHaveLength(0);
    expect(await readFile(owner, "utf8")).toBe(currentOwner);
  });

  it("allows takeover only after the stale lease owner is confirmed dead", async () => {
    const { backupRoot, dataRoot, database } = fixture();
    const lock = path.join(backupRoot, ".locks", "snapshot-create.lock");
    await mkdir(lock, { recursive: true });
    writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ token: "dead", pid: 99, processStartNonce: "dead-process", createdAt: "2026-01-01T00:00:00.000Z" }));
    await utimes(lock, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    const snapshots = new SnapshotService({ dataRoot, backupRoot, database, isProcessAlive: () => false });

    await snapshots.create("2026-07-26");

    expect((await snapshots.list()).map((snapshot) => snapshot.day)).toEqual(["2026-07-26"]);
  });

  it("aborts before manifest publication when the owned lease heartbeat fails", async () => {
    const { dataRoot, backupRoot, database } = fixture();
    const snapshots = new SnapshotService({
      dataRoot,
      backupRoot,
      database,
      leaseHeartbeat: async () => { throw new Error("heartbeat failed"); },
    });

    await expect(snapshots.create("2026-07-26")).rejects.toThrow("BACKUP_LEASE_LOST");
    expect(await snapshots.list()).toEqual([]);
  });

  it("abandons a prepared manifest when the asynchronous lease heartbeat fails during its write", async () => {
    const { dataRoot, backupRoot, database } = fixture();
    let heartbeats = 0;
    const snapshots = new SnapshotService({
      dataRoot,
      backupRoot,
      database,
      leaseHeartbeat: async () => {
        heartbeats += 1;
        if (heartbeats > 1) throw new Error("asynchronous heartbeat failed");
      },
      leaseHeartbeatIntervalMs: 1,
      writeManifestTemporary: async (pathname, contents) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        writeFileSync(pathname, contents);
      },
    });

    await expect(snapshots.create("2026-07-26")).rejects.toThrow("BACKUP_LEASE_LOST");
    expect(await snapshots.list()).toEqual([]);
  });

  it("waits for an in-flight heartbeat failure before publishing a prepared manifest", async () => {
    const { dataRoot, backupRoot, database } = fixture();
    let writingManifest = false;
    let heartbeatStarted!: () => void;
    const started = new Promise<void>((resolve) => { heartbeatStarted = resolve; });
    let rejectHeartbeat!: (error: Error) => void;
    const pendingHeartbeat = new Promise<void>((_resolve, reject) => { rejectHeartbeat = reject; });
    const snapshots = new SnapshotService({
      dataRoot,
      backupRoot,
      database,
      leaseHeartbeatIntervalMs: 25,
      leaseHeartbeat: async () => {
        if (!writingManifest) return;
        heartbeatStarted();
        await pendingHeartbeat;
      },
      writeManifestTemporary: async (pathname, contents) => {
        writingManifest = true;
        writeFileSync(pathname, contents);
        await started;
        setTimeout(() => rejectHeartbeat(new Error("late heartbeat failure")), 0);
      },
    });

    await expect(snapshots.create("2026-07-26")).rejects.toThrow("BACKUP_LEASE_LOST");
    expect(await snapshots.list()).toEqual([]);
  });

  it("does not publish a manifest when writing its temporary file fails", async () => {
    const { dataRoot, backupRoot, database } = fixture();
    const snapshots = new SnapshotService({
      dataRoot,
      backupRoot,
      database,
      writeManifestTemporary: async () => { throw new Error("manifest temporary write failed"); },
    });

    await expect(snapshots.create("2026-07-26")).rejects.toThrow("manifest temporary write failed");
    expect(await snapshots.list()).toEqual([]);
  });

  it("rejects corrupt objects and never publishes a partial restore", async () => {
    const { dataRoot, backupRoot, snapshots } = fixture();
    const source = new MediaStore(path.join(dataRoot, "media"));
    const original = await source.put(Buffer.from("unbroken"), "jpg");
    const snapshot = await snapshots.create("2026-07-26");
    writeFileSync(path.join(backupRoot, "objects", original.hash.slice(0, 2), original.hash), "corrupt");

    const restoreRoot = mkdtempSync(path.join(tmpdir(), "local-diary-backup-restore-"));
    const target = path.join(restoreRoot, "staging");
    roots.push(restoreRoot);
    await expect(snapshots.restore(snapshot.id, target)).rejects.toThrow("BACKUP_OBJECT_CHECKSUM_MISMATCH");
    expect(await readdir(restoreRoot)).toEqual([]);
  });

  it("rejects a missing object without creating the requested restore target", async () => {
    const { dataRoot, backupRoot, snapshots } = fixture();
    const source = new MediaStore(path.join(dataRoot, "media"));
    const original = await source.put(Buffer.from("missing later"), "jpg");
    const snapshot = await snapshots.create("2026-07-26");
    rmSync(path.join(backupRoot, "objects", original.hash.slice(0, 2), original.hash));

    const restoreRoot = mkdtempSync(path.join(tmpdir(), "local-diary-backup-restore-"));
    roots.push(restoreRoot);
    await expect(snapshots.restore(snapshot.id, path.join(restoreRoot, "staging")))
      .rejects.toThrow("BACKUP_OBJECT_MISSING");
    expect(await readdir(restoreRoot)).toEqual([]);
  });

  it("rejects media symlinks and traversal-like logical paths", async () => {
    const { dataRoot, snapshots } = fixture();
    const outside = mkdtempSync(path.join(tmpdir(), "local-diary-backup-outside-"));
    roots.push(outside);
    writeFileSync(path.join(outside, "secret.jpg"), "secret");
    const objects = path.join(dataRoot, "media", "objects");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(objects, { recursive: true }));
    symlinkSync(outside, path.join(objects, "aa"), "junction");

    await expect(snapshots.create("2026-07-26")).rejects.toThrow("BACKUP_UNSAFE_MEDIA_PATH");
  });

  it("runs one backup for an injectable Beijing day and records due state", async () => {
    const { snapshots } = fixture();
    const clock = { publishedAt: () => "2026-07-26T09:00:00+08:00", dayKey: (value: string) => value.slice(0, 10) };

    expect(await runDailyBackupIfDue({ snapshots, clock })).toMatchObject({ created: true, day: "2026-07-26" });
    expect(await runDailyBackupIfDue({ snapshots, clock })).toMatchObject({ created: false, day: "2026-07-26" });
  });

  it("does not move the scheduler state backward when the Beijing clock rolls back", async () => {
    const { snapshots } = fixture();
    let timestamp = "2026-07-27T09:00:00+08:00";
    const clock = { publishedAt: () => timestamp, dayKey: (value: string) => value.slice(0, 10) };

    expect(await runDailyBackupIfDue({ snapshots, clock })).toMatchObject({ created: true, day: "2026-07-27" });
    timestamp = "2026-07-26T09:00:00+08:00";
    expect(await runDailyBackupIfDue({ snapshots, clock })).toMatchObject({ created: false, day: "2026-07-26" });
    expect(snapshots.getLastScheduledDay()).toBe("2026-07-27");
    expect((await snapshots.list()).map((snapshot) => snapshot.day)).toEqual(["2026-07-27"]);
  });
});
