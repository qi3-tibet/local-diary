import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiaryDatabase, type DiaryDatabase } from "../src/db/client.js";
import { buildServer } from "../src/app.js";
import { EntryRepository } from "../src/entries/repository.js";
import { MediaStore } from "../src/media/store.js";
import {
  createFileCleanupLogger,
  runTrashCleanup,
  startTrashCleanupScheduler,
} from "../src/trash/cleanup.js";

describe("trash cleanup and media garbage collection", () => {
  const roots: string[] = [];
  const databases: DiaryDatabase[] = [];

  afterEach(() => {
    databases.splice(0).forEach((database) => {
      try { database.close(); } catch {}
    });
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it("purges expired rows but retains a content-addressed object shared by another entry", async () => {
    const fixture = await setup();
    const expired = publish(fixture.repository, "expired");
    const retained = publish(fixture.repository, "retained");
    const shared = await fixture.store.put(Buffer.from("shared"), "jpg");
    const exclusive = await fixture.store.put(Buffer.from("exclusive"), "jpg");
    insertMedia(fixture.database, expired.id, shared.hash, "jpg");
    insertMedia(fixture.database, expired.id, exclusive.hash, "jpg");
    insertMedia(fixture.database, retained.id, shared.hash, "jpg");
    fixture.repository.trashPublished(expired.id, "2026-06-01T00:00:00.000Z");

    const result = await runTrashCleanup({
      repository: fixture.repository,
      mediaStore: fixture.store,
      now: new Date("2026-07-02T00:00:00.000Z"),
      logger: createFileCleanupLogger(fixture.logPath),
    });

    expect(result).toMatchObject({ purgedEntries: 1, removedObjects: 1, failures: 0 });
    expect(existsSync(shared.path)).toBe(true);
    expect(existsSync(exclusive.path)).toBe(false);
    expect(fixture.database.prepare("SELECT state FROM entries WHERE id = ?").get(retained.id))
      .toEqual({ state: "published" });
    expect(await readFile(fixture.logPath, "utf8")).toContain('"event":"trash-cleanup-complete"');
  });

  it("keeps the database consistent and an orphan recoverable when object deletion fails", async () => {
    const fixture = await setup();
    const expired = publish(fixture.repository, "expired");
    const object = await fixture.store.put(Buffer.from("cannot remove"), "jpg");
    insertMedia(fixture.database, expired.id, object.hash, "jpg");
    fixture.repository.trashPublished(expired.id, "2026-06-01T00:00:00.000Z");
    const remove = vi.spyOn(fixture.store, "remove")
      .mockRejectedValueOnce(new Error("permission denied"));

    const result = await runTrashCleanup({
      repository: fixture.repository,
      mediaStore: fixture.store,
      now: new Date("2026-07-02T00:00:00.000Z"),
      logger: createFileCleanupLogger(fixture.logPath),
    });

    expect(result).toMatchObject({ purgedEntries: 1, removedObjects: 0, failures: 1 });
    expect(fixture.database.prepare("SELECT 1 FROM entries WHERE id = ?").get(expired.id))
      .toBeUndefined();
    expect(existsSync(object.path)).toBe(true);

    remove.mockRestore();
    const retried = await runTrashCleanup({
      repository: fixture.repository,
      mediaStore: fixture.store,
      now: new Date("2026-07-03T00:00:00.000Z"),
      logger: createFileCleanupLogger(fixture.logPath),
    });
    expect(retried).toMatchObject({ purgedEntries: 0, removedObjects: 1, failures: 0 });
    expect(existsSync(object.path)).toBe(false);
  });

  it("runs on startup and schedules the next cleanup at Beijing midnight", async () => {
    let current = new Date("2026-07-26T15:59:30.000Z");
    const cleanup = vi.fn(async () => undefined);
    let scheduled!: () => void;
    let delay = 0;
    const scheduler = startTrashCleanupScheduler({
      cleanup,
      now: () => current,
      setTimer: (callback, milliseconds) => {
        scheduled = callback;
        delay = milliseconds;
        return 1;
      },
      clearTimer: vi.fn(),
    });

    await scheduler.startup;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(delay).toBe(30_000);

    current = new Date("2026-07-26T16:00:00.000Z");
    scheduled();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
    await scheduler.stop();
  });

  it("waits for an in-flight cleanup before the scheduler stops", async () => {
    let releaseCleanup!: () => void;
    const cleanup = vi.fn(() => new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    }));
    const setTimer = vi.fn();
    const scheduler = startTrashCleanupScheduler({
      cleanup,
      setTimer,
    });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    expect(setTimer).not.toHaveBeenCalled();

    releaseCleanup();
    await stopping;
    expect(stopped).toBe(true);
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("settles a stop after an in-flight cleanup rejects without scheduling again", async () => {
    let rejectCleanup!: (error: Error) => void;
    const cleanup = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectCleanup = reject;
    }));
    const setTimer = vi.fn();
    const scheduler = startTrashCleanupScheduler({
      cleanup,
      setTimer,
    });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));

    const stopping = scheduler.stop();
    rejectCleanup(new Error("database is closing"));

    await expect(stopping).resolves.toBeUndefined();
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("wires startup cleanup into the normal local service lifecycle", async () => {
    const fixture = await setup();
    const expired = publish(fixture.repository, "startup-expired");
    const object = await fixture.store.put(Buffer.from("startup orphan"), "jpg");
    insertMedia(fixture.database, expired.id, object.hash, "jpg");
    fixture.repository.trashPublished(
      expired.id,
      new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    );
    const server = buildServer({
      dataRoot: fixture.dataRoot,
      database: fixture.database,
      logRoot: path.dirname(fixture.logPath),
      scheduleBackups: false,
      scheduleTrashCleanup: true,
    });

    await server.ready();

    expect(fixture.database.prepare("SELECT 1 FROM entries WHERE id = ?").get(expired.id))
      .toBeUndefined();
    expect(existsSync(object.path)).toBe(false);
    await server.close();
  });

  async function setup() {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "local-diary-trash-cleanup-"));
    roots.push(dataRoot);
    const database = createDiaryDatabase(dataRoot);
    databases.push(database);
    return {
      dataRoot,
      database,
      repository: new EntryRepository(database),
      store: new MediaStore(path.join(dataRoot, "media")),
      logPath: path.join(dataRoot, "logs", "cleanup.ndjson"),
    };
  }
});

function publish(repository: EntryRepository, suffix: string) {
  const draft = repository.saveDraft({
    title: suffix,
    markdown: `${suffix} body`,
    tags: [],
  });
  return repository.publishDraft(draft.id, "2026-06-01T00:00:00+08:00");
}

function insertMedia(
  database: DiaryDatabase,
  entryId: string,
  hash: string,
  extension: string,
): void {
  database.prepare(`
    INSERT INTO media (
      id, entry_id, original_hash, original_mime, original_extension,
      display_hash, thumbnail_hash, derivative_status, derivative_error,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'image/jpeg', ?, NULL, NULL, 'failed', 'fixture', 'now', 'now')
  `).run(crypto.randomUUID(), entryId, hash, extension);
}
