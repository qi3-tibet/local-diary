import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { BackupSettingsRepository } from "../src/settings/repository.js";

describe("backup settings", () => {
  const roots: string[] = [];
  const servers: ReturnType<typeof buildServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it("persists only a canonical, writable backup root outside the swappable data root", async () => {
    const workspace = temp("diary-settings-");
    const dataRoot = path.join(workspace, "data");
    const settingsPath = path.join(workspace, "settings", "backup.json");
    const chosen = path.join(workspace, "chosen", "..", "chosen");
    const repository = new BackupSettingsRepository({
      dataRoot,
      settingsPath,
      defaultBackupRoot: path.join(workspace, "default-backups"),
    });

    const saved = await repository.setBackupRoot(chosen);

    expect(saved).toMatchObject({
      backupRoot: path.resolve(workspace, "chosen"),
      writable: true,
      existingBackups: "left-in-previous-location",
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      version: 1,
      backupRoot: path.resolve(workspace, "chosen"),
    });
    await expect(new BackupSettingsRepository({
      dataRoot,
      settingsPath,
      defaultBackupRoot: path.join(workspace, "another-default"),
    }).get()).resolves.toMatchObject({ backupRoot: path.resolve(workspace, "chosen") });
  });

  it("rejects the data root, its descendants, filesystem roots, and non-directories without replacing the remembered location", async () => {
    const workspace = temp("diary-settings-invalid-");
    const dataRoot = path.join(workspace, "data");
    const settingsPath = path.join(workspace, "backup.json");
    const valid = path.join(workspace, "valid");
    const repository = new BackupSettingsRepository({
      dataRoot,
      settingsPath,
      defaultBackupRoot: path.join(workspace, "default"),
    });
    await repository.setBackupRoot(valid);
    const file = path.join(workspace, "file");
    writeFileSync(file, "not a directory");

    await expect(repository.setBackupRoot(dataRoot)).rejects.toThrow("BACKUP_LOCATION_UNSAFE");
    await expect(repository.setBackupRoot(path.join(dataRoot, "nested"))).rejects.toThrow("BACKUP_LOCATION_UNSAFE");
    await expect(repository.setBackupRoot(path.parse(workspace).root)).rejects.toThrow("BACKUP_LOCATION_UNSAFE");
    await expect(repository.setBackupRoot(file)).rejects.toThrow("BACKUP_LOCATION_NOT_WRITABLE");
    await expect(repository.get()).resolves.toMatchObject({ backupRoot: path.resolve(valid), writable: true });
  });

  it("exposes remembered settings, reconfigures live snapshots, and creates a fresh manual snapshot", async () => {
    const workspace = temp("diary-settings-route-");
    const dataRoot = path.join(workspace, "data");
    const settingsPath = path.join(workspace, "settings.json");
    const firstBackupRoot = path.join(workspace, "backup-a");
    const secondBackupRoot = path.join(workspace, "backup-b");
    const server = buildServer({ dataRoot, backupRoot: firstBackupRoot, settingsPath });
    servers.push(server);

    const initial = await server.inject({ method: "GET", url: "/api/v1/settings/backup" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ backupRoot: path.resolve(firstBackupRoot), writable: true });

    const changed = await server.inject({
      method: "PUT",
      url: "/api/v1/settings/backup",
      payload: { backupRoot: secondBackupRoot },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      backupRoot: path.resolve(secondBackupRoot),
      writable: true,
      existingBackups: "left-in-previous-location",
    });

    const manual = await server.inject({ method: "POST", url: "/api/v1/backups/snapshot" });
    expect(manual.statusCode).toBe(201);
    expect(manual.json().snapshotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(path.join(secondBackupRoot, "restore-safety", `${manual.json().snapshotId}.json`), "utf8"))
      .toContain(manual.json().snapshotId);
  });

  it("returns a persistent writable warning without changing live backup services", async () => {
    const workspace = temp("diary-settings-warning-");
    const dataRoot = path.join(workspace, "data");
    const good = path.join(workspace, "good");
    const server = buildServer({
      dataRoot,
      backupRoot: good,
      settingsPath: path.join(workspace, "settings.json"),
    });
    servers.push(server);
    const file = path.join(workspace, "not-a-directory");
    writeFileSync(file, "x");

    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/settings/backup",
      payload: { backupRoot: file },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: "BACKUP_LOCATION_NOT_WRITABLE",
      recovery: "CHOOSE ANOTHER LOCATION",
    });
    const after = await server.inject({ method: "GET", url: "/api/v1/settings/backup" });
    expect(after.json()).toMatchObject({ backupRoot: path.resolve(good), writable: true });
  });

  it("does not let a delayed GET overwrite a newer verified PUT", async () => {
    const workspace = temp("diary-settings-race-");
    const original = path.join(workspace, "original");
    const replacement = path.join(workspace, "replacement");
    let releaseFirst!: () => void;
    const firstVerification = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let verificationCount = 0;
    const repository = new BackupSettingsRepository({
      dataRoot: path.join(workspace, "data"),
      settingsPath: path.join(workspace, "settings.json"),
      defaultBackupRoot: original,
      verifyRoot: async (candidate) => {
        verificationCount += 1;
        if (verificationCount === 1) await firstVerification;
        return path.resolve(candidate);
      },
    });

    const delayedGet = repository.get();
    await Promise.resolve();
    const put = repository.setBackupRoot(replacement);
    await Promise.resolve();
    releaseFirst();

    await expect(delayedGet).resolves.toMatchObject({ backupRoot: path.resolve(original) });
    await expect(put).resolves.toMatchObject({ backupRoot: path.resolve(replacement) });
    await expect(repository.get()).resolves.toMatchObject({ backupRoot: path.resolve(replacement) });
    expect(verificationCount).toBe(3);
  });

  function temp(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
});
