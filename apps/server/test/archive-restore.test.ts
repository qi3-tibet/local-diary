import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import yazl from "yazl";
import { SnapshotService } from "../src/backup/snapshot.js";
import {
  ARCHIVE_TRANSPORT_OVERHEAD_BYTES,
  MAX_ARCHIVE_CONTENT_BYTES,
  MAX_ARCHIVE_TRANSPORT_BYTES,
  exportArchive,
} from "../src/backup/archive.js";
import { restoreArchive } from "../src/backup/restore.js";
import { createDiaryDatabase, type DiaryDatabase } from "../src/db/client.js";
import { MediaStore } from "../src/media/store.js";
import { buildServer } from "../src/app.js";
import Database from "better-sqlite3";
import { CURRENT_DIARY_SCHEMA_VERSION } from "../src/db/client.js";

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

  it("rejects a future database schema before the live barrier or mutation", async () => {
    expect(CURRENT_DIARY_SCHEMA_VERSION).toBe(11);
    const candidateRoot = temp("archive-future-candidate-");
    const candidate = createDiaryDatabase(candidateRoot);
    candidate.pragma(`user_version = ${CURRENT_DIARY_SCHEMA_VERSION + 1}`);
    candidate.close();
    const archive = await archiveForDatabase(join(candidateRoot, "diary.sqlite"));
    const live = temp("archive-future-live-");
    const liveDatabase = createDiaryDatabase(live);
    liveDatabase.prepare("INSERT INTO backup_state (key, value, updated_at) VALUES ('proof', 'untouched', 'now')").run();
    liveDatabase.close();
    const before = await readFile(join(live, "diary.sqlite"));
    let barrierCalls = 0;

    await expect(restoreArchive(archive, {
      dataRoot: live,
      temporaryRoot: temp("archive-future-temp-"),
      coordinator: coordinator(() => { barrierCalls += 1; }),
    })).rejects.toThrow("ARCHIVE_DATABASE_UNSUPPORTED");

    expect(barrierCalls).toBe(0);
    expect(await readFile(join(live, "diary.sqlite"))).toEqual(before);
  });

  it("rejects an incomplete current-version schema before live mutation", async () => {
    const candidateRoot = temp("archive-incomplete-candidate-");
    const pathname = join(candidateRoot, "diary.sqlite");
    const candidate = new Database(pathname);
    candidate.exec("CREATE TABLE entries (id TEXT PRIMARY KEY)");
    candidate.pragma(`user_version = ${CURRENT_DIARY_SCHEMA_VERSION}`);
    candidate.close();
    const archive = await archiveForDatabase(pathname);
    const live = temp("archive-incomplete-live-");
    const liveDatabase = createDiaryDatabase(live);
    liveDatabase.prepare("INSERT INTO backup_state (key, value, updated_at) VALUES ('proof', 'untouched', 'now')").run();
    liveDatabase.close();
    const before = await readFile(join(live, "diary.sqlite"));
    let barrierCalls = 0;

    await expect(restoreArchive(archive, {
      dataRoot: live,
      temporaryRoot: temp("archive-incomplete-temp-"),
      coordinator: coordinator(() => { barrierCalls += 1; }),
    })).rejects.toThrow("ARCHIVE_DATABASE_INVALID");

    expect(barrierCalls).toBe(0);
    expect(await readFile(join(live, "diary.sqlite"))).toEqual(before);
  });

  it("rejects a normal table masquerading as the required FTS index before the barrier", async () => {
    const candidateRoot = temp("archive-fake-fts-candidate-");
    const candidate = createDiaryDatabase(candidateRoot);
    candidate.exec(`
      DROP TABLE entry_search;
      CREATE TABLE entry_search (
        entry_id TEXT,
        title TEXT,
        body TEXT,
        tags TEXT,
        song_title TEXT,
        song_artist TEXT,
        song_album TEXT
      );
    `);
    candidate.close();
    const archive = await archiveForDatabase(join(candidateRoot, "diary.sqlite"));
    const live = temp("archive-fake-fts-live-");
    const liveDatabase = createDiaryDatabase(live);
    liveDatabase.prepare(
      "INSERT INTO backup_state (key, value, updated_at) VALUES ('proof', 'untouched', 'now')",
    ).run();
    liveDatabase.close();
    const before = await readFile(join(live, "diary.sqlite"));
    let barrierCalls = 0;

    await expect(restoreArchive(archive, {
      dataRoot: live,
      temporaryRoot: temp("archive-fake-fts-temp-"),
      coordinator: coordinator(() => { barrierCalls += 1; }),
    })).rejects.toThrow("ARCHIVE_DATABASE_INVALID");

    expect(barrierCalls).toBe(0);
    expect(await readFile(join(live, "diary.sqlite"))).toEqual(before);
  });

  it("rejects same-column relationship tables without the required cascade constraints", async () => {
    const candidateRoot = temp("archive-missing-foreign-key-candidate-");
    const candidate = createDiaryDatabase(candidateRoot);
    candidate.pragma("foreign_keys = OFF");
    candidate.exec(`
      ALTER TABLE entry_tags RENAME TO entry_tags_with_foreign_keys;
      CREATE TABLE entry_tags (
        entry_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        PRIMARY KEY(entry_id, tag_id)
      );
      DROP TABLE entry_tags_with_foreign_keys;
    `);
    candidate.close();
    const archive = await archiveForDatabase(join(candidateRoot, "diary.sqlite"));
    const live = temp("archive-missing-foreign-key-live-");
    const liveDatabase = createDiaryDatabase(live);
    liveDatabase.prepare(
      "INSERT INTO backup_state (key, value, updated_at) VALUES ('proof', 'untouched', 'now')",
    ).run();
    liveDatabase.close();
    const before = await readFile(join(live, "diary.sqlite"));
    let barrierCalls = 0;

    await expect(restoreArchive(archive, {
      dataRoot: live,
      temporaryRoot: temp("archive-missing-foreign-key-temp-"),
      coordinator: coordinator(() => { barrierCalls += 1; }),
    })).rejects.toThrow("ARCHIVE_DATABASE_INVALID");

    expect(barrierCalls).toBe(0);
    expect(await readFile(join(live, "diary.sqlite"))).toEqual(before);
  });

  it("rejects a wrong index whose SQL comment contains the expected definition", async () => {
    const candidateRoot = temp("archive-spoofed-index-candidate-");
    const candidate = createDiaryDatabase(candidateRoot);
    candidate.exec(`
      DROP INDEX one_draft_only;
      CREATE UNIQUE INDEX one_draft_only ON entries(
        /* on entries(state) where state = 'draft' */
        title
      );
    `);
    candidate.close();
    const archive = await archiveForDatabase(join(candidateRoot, "diary.sqlite"));
    const live = temp("archive-spoofed-index-live-");
    const liveDatabase = createDiaryDatabase(live);
    liveDatabase.prepare(
      "INSERT INTO backup_state (key, value, updated_at) VALUES ('proof', 'untouched', 'now')",
    ).run();
    liveDatabase.close();
    const before = await readFile(join(live, "diary.sqlite"));
    let barrierCalls = 0;

    await expect(restoreArchive(archive, {
      dataRoot: live,
      temporaryRoot: temp("archive-spoofed-index-temp-"),
      coordinator: coordinator(() => { barrierCalls += 1; }),
    })).rejects.toThrow("ARCHIVE_DATABASE_INVALID");

    expect(barrierCalls).toBe(0);
    expect(await readFile(join(live, "diary.sqlite"))).toEqual(before);
  });

  it("stage-migrates a supported older schema and validates the complete current schema", async () => {
    const candidateRoot = temp("archive-older-candidate-");
    const candidate = createDiaryDatabase(candidateRoot);
    candidate.exec(`
      DROP INDEX entries_published_day_cursor;
      DROP INDEX entries_published_cursor;
      DROP TABLE trash_cleanup_objects;
    `);
    candidate.pragma("user_version = 8");
    candidate.close();
    const archive = await archiveForDatabase(join(candidateRoot, "diary.sqlite"));
    const restoredRoot = temp("archive-older-restored-");

    await restoreArchive(archive, {
      dataRoot: restoredRoot,
      temporaryRoot: temp("archive-older-temp-"),
    });

    const restored = new Database(join(restoredRoot, "diary.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    expect(restored.pragma("user_version", { simple: true })).toBe(CURRENT_DIARY_SCHEMA_VERSION);
    expect(restored.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'entries_published_cursor'",
    ).get()).toEqual({ name: "entries_published_cursor" });
    restored.close();
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
    expect(restored.body.trim().split("\n").map((line) => JSON.parse(line).phase)).toEqual([
      "VALIDATING",
      "SAFETY_BACKUP",
      "RESTORING",
      "REBUILDING",
      "DONE",
    ]);
    const safetyDatabase = createDiaryDatabase(dataRoot);
    const safetySnapshots = new SnapshotService({ dataRoot, backupRoot, database: safetyDatabase });
    const safety = (await safetySnapshots.listSafety()).at(-1);
    expect(safety?.id).not.toBe(snapshot.id);
    expect(safety?.databaseObject).not.toBe(snapshot.databaseObject);
    const safetyRoot = temp("archive-safety-");
    await safetySnapshots.restoreSafety(safety!.id, join(safetyRoot, "restored"));
    const recovered = createDiaryDatabase(join(safetyRoot, "restored"));
    expect(recovered.prepare("SELECT title FROM entries").get()).toEqual({ title: "Changed" });
    recovered.close(); safetyDatabase.close();
    expect(JSON.parse((await server.inject({ method: "GET", url: "/api/v1/entries" })).body)[0].markdown).toBe("archived searchable body");
    expect(JSON.parse((await server.inject({ method: "GET", url: "/api/v1/search?q=kept" })).body).items).toHaveLength(1);
    const next = await server.inject({ method: "PUT", url: "/api/v1/draft", payload: { title: "After", markdown: "after restore", tags: [] } });
    expect(next.statusCode).toBe(200);
  });

  it("waits for the active trash cleanup before closing the database for restore", async () => {
    const dataRoot = temp("archive-cleanup-barrier-");
    const backupRoot = temp("archive-cleanup-barrier-backup-");
    const database = createDiaryDatabase(dataRoot);
    databases.push(database);
    let releaseCleanupStop!: () => void;
    const stop = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseCleanupStop = resolve;
      }))
      .mockResolvedValue(undefined);
    const schedulerFactory = vi.fn(() => ({
      startup: Promise.resolve(),
      stop,
    }));
    const close = vi.spyOn(database, "close");
    const server = buildServer({
      dataRoot,
      backupRoot,
      database,
      scheduleBackups: false,
      scheduleTrashCleanup: true,
      trashCleanupSchedulerFactory: schedulerFactory,
    });
    servers.push(server);
    await server.ready();
    const snapshots = new SnapshotService({ dataRoot, backupRoot, database });
    const snapshot = await snapshots.create("2026-07-26");
    const archive = join(temp("archive-cleanup-barrier-output-"), "archive.zip");
    await exportArchive(snapshot.id, snapshots, archive);
    const bytes = await readFile(archive);
    const boundary = "restore-cleanup-barrier";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="archive.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const restoring = server.inject({
      method: "POST",
      url: "/api/v1/backups/restore",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(close).not.toHaveBeenCalled();

    releaseCleanupStop();
    const response = await restoring;
    expect(response.body).toContain('"phase":"DONE"');
    expect(close).toHaveBeenCalledTimes(1);
    expect(schedulerFactory).toHaveBeenCalledTimes(2);
  });

  it("streams FAILED for a corrupt uploaded archive without mutating live data", async () => {
    const dataRoot = temp("archive-corrupt-route-");
    const server = buildServer({ dataRoot, backupRoot: temp("archive-corrupt-backup-") });
    servers.push(server);
    await server.inject({
      method: "PUT",
      url: "/api/v1/draft",
      payload: { title: "Untouched", markdown: "The current diary remains.", tags: [] },
    });
    await server.inject({ method: "POST", url: "/api/v1/draft/publish" });
    const boundary = "corrupt-restore-boundary";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="archive.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from("not a zip"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/backups/restore",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.body.trim().split("\n").map((line) => JSON.parse(line).phase)).toEqual([
      "VALIDATING",
      "FAILED",
    ]);
    expect(JSON.parse((await server.inject({ method: "GET", url: "/api/v1/entries" })).body)[0].markdown)
      .toBe("The current diary remains.");
  });

  it("keeps restore transport large enough for every export-valid archive with bounded overhead", () => {
    expect(MAX_ARCHIVE_CONTENT_BYTES).toBe(20 * 1024 * 1024 * 1024);
    expect(MAX_ARCHIVE_TRANSPORT_BYTES).toBe(
      MAX_ARCHIVE_CONTENT_BYTES + ARCHIVE_TRANSPORT_OVERHEAD_BYTES,
    );
    expect(ARCHIVE_TRANSPORT_OVERHEAD_BYTES).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(ARCHIVE_TRANSPORT_OVERHEAD_BYTES).toBeLessThanOrEqual(1024 * 1024 * 1024);
  });

  it("accepts an archive at the configured transport boundary and rejects one byte over", async () => {
    const dataRoot = temp("archive-boundary-route-");
    const server = buildServer({
      dataRoot,
      backupRoot: temp("archive-boundary-backup-"),
      restoreUploadLimit: 16,
    });
    servers.push(server);

    const accepted = await uploadBytes(server, Buffer.alloc(16));
    const oversized = await uploadBytes(server, Buffer.alloc(17));

    expect(accepted).not.toContain("ARCHIVE_SIZE_LIMIT");
    expect(oversized).toContain("ARCHIVE_SIZE_LIMIT");
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

  async function uploadBytes(
    server: ReturnType<typeof buildServer>,
    bytes: Buffer,
  ): Promise<string> {
    const boundary = `capacity-${randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="archive.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return (await server.inject({
      method: "POST",
      url: "/api/v1/backups/restore",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })).body;
  }

  async function archiveForDatabase(databasePath: string): Promise<string> {
    const bytes = await readFile(databasePath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const archive = join(temp("archive-schema-output-"), "schema.zip");
    await writeArchive(archive, {
      format: "local-diary-snapshot",
      version: 1,
      id: randomUUID(),
      day: "2026-07-26",
      createdAt: "2026-07-26T00:00:00.000+08:00",
      databaseObject: hash,
      mediaObjects: [],
    }, [[hash, bytes]]);
    return archive;
  }

  function coordinator(onBarrier: () => void) {
    return {
      acquireBarrier: async () => {
        onBarrier();
        return () => undefined;
      },
      createSafetySnapshot: async () => undefined,
      quiesce: async () => undefined,
      reopen: async () => undefined,
    };
  }
});
