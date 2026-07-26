export type DiaryWritableFile = {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
};

export type DiaryFileHandle = {
  createWritable(): Promise<DiaryWritableFile>;
};

export type DiaryDirectoryHandle = {
  kind: "directory";
  name: string;
  queryPermission(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
  getFileHandle(name: string, options: { create: true }): Promise<DiaryFileHandle>;
};

export type DirectoryHandleStore = {
  load(): Promise<DiaryDirectoryHandle | null>;
  save(handle: DiaryDirectoryHandle): Promise<void>;
  clear(): Promise<void>;
};

const DATABASE_NAME = "local-diary-browser-settings";
const STORE_NAME = "directory-handles";
const HANDLE_KEY = "manual-export-directory";

export const browserDirectoryHandleStore: DirectoryHandleStore = {
  async load() {
    if (!globalThis.indexedDB) return null;
    const value = await requestFromStore("readonly", (store) => store.get(HANDLE_KEY));
    return isDirectoryHandle(value) ? value : null;
  },
  async save(handle) {
    if (!globalThis.indexedDB) throw new Error("BROWSER_DIRECTORY_STORAGE_UNAVAILABLE");
    await requestFromStore("readwrite", (store) => store.put(handle, HANDLE_KEY));
  },
  async clear() {
    if (!globalThis.indexedDB) return;
    await requestFromStore("readwrite", (store) => store.delete(HANDLE_KEY));
  },
};

export async function restoreGrantedDirectory(
  store: DirectoryHandleStore,
): Promise<DiaryDirectoryHandle | null> {
  try {
    const handle = await store.load();
    if (!handle) return null;
    let permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission === "prompt") {
      permission = await handle.requestPermission({ mode: "readwrite" });
    }
    if (permission === "granted") return handle;
    await store.clear();
    return null;
  } catch {
    return null;
  }
}

export async function writeBlobToDirectory(
  directory: DiaryDirectoryHandle,
  filename: string,
  blob: Blob,
): Promise<void> {
  if (!/^[^<>:"/\\|?*\u0000-\u001f]+\.zip$/u.test(filename)) {
    throw new Error("EXPORT_FILENAME_INVALID");
  }
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => {});
    throw error;
  }
}

function requestFromStore(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onerror = () => reject(request.error ?? new Error("BROWSER_DIRECTORY_STORAGE_FAILED"));
    request.onsuccess = () => resolve(request.result);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("BROWSER_DIRECTORY_STORAGE_FAILED"));
    };
  }));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onerror = () => reject(request.error ?? new Error("BROWSER_DIRECTORY_STORAGE_FAILED"));
    request.onsuccess = () => resolve(request.result);
  });
}

function isDirectoryHandle(value: unknown): value is DiaryDirectoryHandle {
  if (!value || typeof value !== "object") return false;
  const handle = value as Partial<DiaryDirectoryHandle>;
  return handle.kind === "directory"
    && typeof handle.name === "string"
    && typeof handle.queryPermission === "function"
    && typeof handle.requestPermission === "function"
    && typeof handle.getFileHandle === "function";
}
