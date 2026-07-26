import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type StoredBackupSettings = {
  version: 1;
  backupRoot: string;
};

export type BackupSettings = {
  backupRoot: string;
  writable: boolean;
  existingBackups: "left-in-previous-location";
  selectionMode: "server-path";
};

export class BackupLocationError extends Error {
  constructor(readonly code: "BACKUP_LOCATION_UNSAFE" | "BACKUP_LOCATION_NOT_WRITABLE") {
    super(code);
  }
}

export class BackupSettingsRepository {
  private readonly dataRoot: string;
  private readonly settingsPath: string;
  private readonly defaultBackupRoot: string;
  private readonly verifyRoot: (candidate: string, dataRoot: string) => Promise<string>;
  private configuredBackupRoot: string;
  private writeTail = Promise.resolve();

  constructor(options: {
    dataRoot: string;
    settingsPath: string;
    defaultBackupRoot: string;
    verifyRoot?: (candidate: string, dataRoot: string) => Promise<string>;
  }) {
    this.dataRoot = path.resolve(options.dataRoot);
    this.settingsPath = path.resolve(options.settingsPath);
    this.defaultBackupRoot = path.resolve(options.defaultBackupRoot);
    this.verifyRoot = options.verifyRoot ?? verifyBackupRoot;
    this.configuredBackupRoot = this.readStoredRootSync() ?? this.defaultBackupRoot;
  }

  currentBackupRoot(): string {
    return this.configuredBackupRoot;
  }

  async get(): Promise<BackupSettings> {
    return this.serialized(async () => {
      const backupRoot = this.configuredBackupRoot;
      try {
        const canonical = await this.verifyRoot(backupRoot, this.dataRoot);
        this.configuredBackupRoot = canonical;
        return result(canonical, true);
      } catch {
        return result(backupRoot, false);
      }
    });
  }

  async setBackupRoot(candidate: string): Promise<BackupSettings> {
    if (typeof candidate !== "string" || candidate.trim() === "" || !path.isAbsolute(candidate)) {
      throw new BackupLocationError("BACKUP_LOCATION_UNSAFE");
    }
    return this.serialized(async () => {
      const canonical = await this.verifyRoot(candidate, this.dataRoot);
      await this.persist({ version: 1, backupRoot: canonical });
      this.configuredBackupRoot = canonical;
      return result(canonical, true);
    });
  }

  private readStoredRootSync(): string | null {
    try {
      const bytes = requireFile(this.settingsPath);
      const parsed = JSON.parse(bytes) as Partial<StoredBackupSettings>;
      if (parsed.version !== 1 || typeof parsed.backupRoot !== "string" || !path.isAbsolute(parsed.backupRoot)) {
        return null;
      }
      return path.resolve(parsed.backupRoot);
    } catch {
      return null;
    }
  }

  private async persist(settings: StoredBackupSettings): Promise<void> {
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    const temporary = path.join(
      path.dirname(this.settingsPath),
      `.${path.basename(this.settingsPath)}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, `${JSON.stringify(settings)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.settingsPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

async function verifyBackupRoot(candidate: string, dataRoot: string): Promise<string> {
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root || within(dataRoot, resolved)) {
    throw new BackupLocationError("BACKUP_LOCATION_UNSAFE");
  }
  try {
    await mkdir(resolved, { recursive: true });
    const finalNode = await lstat(resolved);
    if (!finalNode.isDirectory() || finalNode.isSymbolicLink()) {
      throw new BackupLocationError("BACKUP_LOCATION_NOT_WRITABLE");
    }
    const canonical = await realpath(resolved);
    if (canonical === path.parse(canonical).root || within(await canonicalDataRoot(dataRoot), canonical)) {
      throw new BackupLocationError("BACKUP_LOCATION_UNSAFE");
    }
    await writableProbe(canonical);
    return path.resolve(canonical);
  } catch (error) {
    if (error instanceof BackupLocationError) throw error;
    throw new BackupLocationError("BACKUP_LOCATION_NOT_WRITABLE");
  }
}

async function writableProbe(root: string): Promise<void> {
  const probe = path.join(root, `.local-diary-write-probe-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(probe, "wx", 0o600);
    await handle.writeFile("local diary backup probe\n");
    await handle.sync();
  } finally {
    await handle?.close();
    await rm(probe, { force: true });
  }
}

async function canonicalDataRoot(dataRoot: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  return path.resolve(await realpath(dataRoot));
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function result(backupRoot: string, writable: boolean): BackupSettings {
  return {
    backupRoot,
    writable,
    existingBackups: "left-in-previous-location",
    selectionMode: "server-path",
  };
}

function requireFile(pathname: string): string {
  // Constructor-time resolution keeps buildServer synchronous. The file is
  // outside the swappable data root, and every write is an atomic JSON replace.
  return readFileSync(pathname, "utf8");
}
