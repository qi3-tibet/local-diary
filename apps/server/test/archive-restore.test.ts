import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import yazl from "yazl";
import { SnapshotService } from "../src/backup/snapshot.js";
import { exportArchive } from "../src/backup/archive.js";
import { restoreArchive } from "../src/backup/restore.js";
import { createDiaryDatabase, type DiaryDatabase } from "../src/db/client.js";
import { MediaStore } from "../src/media/store.js";
import { buildServer } from "../src/app.js";

describe("complete archive restore", () => {
  const roots: string[] = [];
  const databases: DiaryDatabase[] = [];
  const servers: ReturnType<typeof buildServer>[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    databases.splice(0).forEach((database) => { try { database.close(); } catch {} });
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

  it("publishes only one deterministic archive when concurrent writers choose the same target", async () => {
    const dataRoot = temp("archive-data-");
    const backupRoot = temp("archive-backup-");
    const database = createDiaryDatabase(dataRoot); databases.push(database);
    const snapshots = new SnapshotService({ dataRoot, backupRoot, database });
    const snapshot = await snapshots.create("2026-07-26");
    const archive = join(temp("archive-output-"), "diary.zip");

    const results = await Promise.allSettled([
      exportArchive(snapshot.id, snapshots, archive),
      exportArchive(snapshot.id, snapshots, archive),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(restoreArchive(archive, { dataRoot: temp("archive-restore-"), temporaryRoot: temp("archive-temp-") })).resolves.toBeUndefined();
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

  it("rejects a checksum-valid but invalid SQLite candidate before modifying live data", async () => {
    const live = temp("archive-live-"); const database = createDiaryDatabase(live); database.close();
    const before = await readFile(join(live, "diary.sqlite"));
    const invalid = Buffer.from("this is not a sqlite database");
    const hash = createHash("sha256").update(invalid).digest("hex");
    const archive = join(temp("archive-output-"), "invalid.sqlite.zip");
    await writeArchive(archive, {
      format: "local-diary-snapshot", version: 1, id: randomUUID(), day: "2026-07-26",
      createdAt: "2026-07-26T00:00:00.000+08:00", databaseObject: hash, mediaObjects: [],
    }, [[hash, invalid]]);

    await expect(restoreArchive(archive, { dataRoot: live, temporaryRoot: temp("archive-temp-") }))
      .rejects.toThrow("ARCHIVE_DATABASE_INVALID");
    expect(await readFile(join(live, "diary.sqlite"))).toEqual(before);
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
    await expect(restoreArchive(archive, { dataRoot, temporaryRoot: temp("archive-temp-") }))
      .rejects.toThrow("RESTORE_CONTEXT_REQUIRED");
    expect(await readFile(join(dataRoot, "diary.sqlite"))).toEqual(before);
  });

  it("holds the write barrier across safety snapshot, swap, and rebuild", async () => {
    const source = temp("archive-source-");
    const backupRoot = temp("archive-backup-");
    const database = createDiaryDatabase(source); databases.push(database);
    const snapshots = new SnapshotService({ dataRoot: source, backupRoot, database });
    const snapshot = await snapshots.create("2026-07-26");
    const archive = join(temp("archive-output-"), "diary.zip"); await exportArchive(snapshot.id, snapshots, archive);
    const live = temp("archive-live-"); await writeFile(join(live, "diary.sqlite"), "old");
    const events: string[] = [];
    await restoreArchive(archive, { dataRoot: live, temporaryRoot: temp("archive-temp-"), coordinator: {
      acquireBarrier: async () => { events.push("BARRIER"); return () => { events.push("RESUME"); }; },
      createSafetySnapshot: async () => { events.push("SAFETY"); },
      quiesce: async () => { events.push("QUIESCE"); },
      rebuildDerivedData: async () => { events.push("REBUILD"); },
      reopen: async () => { events.push("REOPEN"); },
    } });
    expect(events).toEqual(["BARRIER", "SAFETY", "QUIESCE", "REBUILD", "REOPEN", "RESUME"]);
  });

  it("rolls back and reopens the previous diary when opening restored services fails", async () => {
    const source = temp("archive-source-"); const backupRoot = temp("archive-backup-");
    const sourceDatabase = createDiaryDatabase(source); databases.push(sourceDatabase);
    const snapshots = new SnapshotService({ dataRoot: source, backupRoot, database: sourceDatabase });
    const snapshot = await snapshots.create("2026-07-26");
    const archive = join(temp("archive-output-"), "diary.zip"); await exportArchive(snapshot.id, snapshots, archive);
    const live = temp("archive-live-"); const oldDatabase = createDiaryDatabase(live); oldDatabase.close();
    const before = await readFile(join(live, "diary.sqlite"));
    let reopened = 0; let released = 0;

    await expect(restoreArchive(archive, { dataRoot: live, temporaryRoot: temp("archive-temp-"), coordinator: {
      acquireBarrier: async () => () => { released += 1; }, createSafetySnapshot: async () => {}, quiesce: async () => {},
      rebuildDerivedData: async () => {}, reopen: async () => { reopened += 1; if (reopened === 1) throw new Error("open failed"); },
    } })).rejects.toThrow("open failed");

    expect(await readFile(join(live, "diary.sqlite"))).toEqual(before);
    expect(reopened).toBe(2);
    expect(released).toBe(1);
  });

  it("retains the old recovery directory and keeps the gate closed when rollback rename fails", async () => {
    const source = temp("archive-source-"); const backupRoot = temp("archive-backup-");
    const sourceDatabase = createDiaryDatabase(source); databases.push(sourceDatabase);
    const snapshots = new SnapshotService({ dataRoot: source, backupRoot, database: sourceDatabase });
    const snapshot = await snapshots.create("2026-07-26");
    const archive = join(temp("archive-output-"), "diary.zip"); await exportArchive(snapshot.id, snapshots, archive);
    const live = temp("archive-live-"); const oldDatabase = createDiaryDatabase(live); oldDatabase.close();
    let released = 0;

    await expect(restoreArchive(archive, { dataRoot: live, temporaryRoot: temp("archive-temp-"), coordinator: {
      acquireBarrier: async () => () => { released += 1; }, createSafetySnapshot: async () => {}, quiesce: async () => {},
      rebuildDerivedData: async () => {}, reopen: async () => { throw new Error("new database cannot open"); },
    }, operations: {
      rename: async (from, to) => {
        if (from.includes(".old-") && to === live) throw new Error("rollback rename failed");
        await (await import("node:fs/promises")).rename(from, to);
      },
    } })).rejects.toThrow("RESTORE_RECOVERY_REQUIRED");

    await expect(lstat(live)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(dirname(live))).some((name) => name.startsWith(`${basename(live)}.old-`))).toBe(true);
    expect(released).toBe(0);
  });

  it("releases the in-process restore queue even when lease cleanup reports an error", async () => {
    const source = temp("archive-source-"); const backupRoot = temp("archive-backup-");
    const sourceDatabase = createDiaryDatabase(source); databases.push(sourceDatabase);
    const snapshots = new SnapshotService({ dataRoot: source, backupRoot, database: sourceDatabase });
    const snapshot = await snapshots.create("2026-07-26");
    const archive = join(temp("archive-output-"), "diary.zip"); await exportArchive(snapshot.id, snapshots, archive);
    const live = temp("archive-live-"); let failLeaseRelease = true;
    const coordinator = {
      acquireBarrier: async () => () => {}, createSafetySnapshot: async () => {}, quiesce: async () => {},
      rebuildDerivedData: async () => {}, reopen: async () => {},
    };
    const context = { dataRoot: live, temporaryRoot: temp("archive-temp-"), coordinator, operations: {
      afterLeaseRelease: async () => { if (failLeaseRelease) { failLeaseRelease = false; throw new Error("lease cleanup failed"); } },
    } };

    const results = await Promise.allSettled([restoreArchive(archive, context), restoreArchive(archive, context)]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("restores a normal server route and all request-time services use restored data", async () => {
    const dataRoot = temp("archive-app-"); const backupRoot = temp("archive-app-backup-");
    const database = createDiaryDatabase(dataRoot); databases.push(database);
    const server = buildServer({ dataRoot, backupRoot, database }); servers.push(server);
    const draft = await server.inject({ method: "PUT", url: "/api/v1/draft", payload: { title: "Archived title", markdown: "archived searchable body", tags: ["kept"] } });
    await server.inject({ method: "POST", url: "/api/v1/draft/publish" });
    const snapshots = new SnapshotService({ dataRoot, backupRoot, database });
    const snapshot = await snapshots.create("2026-07-26"); const archive = join(temp("archive-output-"), "archive.zip");
    await exportArchive(snapshot.id, snapshots, archive);
    await server.inject({ method: "PATCH", url: `/api/v1/entries/${JSON.parse((await server.inject({ method: "GET", url: "/api/v1/entries" })).body)[0].id}`, payload: { title: "Changed", markdown: "changed", tags: [] } });
    const boundary = "restore-test-boundary"; const bytes = await readFile(archive);
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="archive.zip"\r\nContent-Type: application/zip\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const restored = await server.inject({ method: "POST", url: "/api/v1/backups/restore", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(restored.body).toContain("DONE");
    expect(JSON.parse((await server.inject({ method: "GET", url: "/api/v1/entries" })).body)[0].markdown).toBe("archived searchable body");
    expect(JSON.parse((await server.inject({ method: "GET", url: "/api/v1/search?q=kept" })).body).items).toHaveLength(1);
    const next = await server.inject({ method: "PUT", url: "/api/v1/draft", payload: { title: "After", markdown: "after restore", tags: [] } });
    expect(next.statusCode).toBe(200);
  });

  function temp(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  async function writeArchive(pathname: string, manifest: object, objects: Array<[string, Buffer]>): Promise<void> {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json", { compress: false });
    objects.forEach(([hash, bytes]) => zip.addBuffer(bytes, `objects/${hash}`, { compress: false }));
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(pathname, { flags: "wx" }));
  }
});
