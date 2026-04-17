import type {
  CodexWasmJournalEntry,
  CodexWasmJournalFilter,
} from "./codexWasmWorkerProtocol";

const DB_NAME = "runme-codex-wasm";
const STORE_NAME = "event-journal";
const DB_VERSION = 1;

let inMemoryEntries: CodexWasmJournalEntry[] = [];

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "seq",
        });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("threadId", "threadId", { unique: false });
        store.createIndex("turnId", "turnId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDatabase();
  if (!db) {
    return await fn({
      put: (value: unknown) => {
        inMemoryEntries.push(value as CodexWasmJournalEntry);
        return {} as IDBRequest;
      },
      clear: () => {
        inMemoryEntries = [];
        return {} as IDBRequest;
      },
    } as IDBObjectStore);
  }
  return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    Promise.resolve(fn(store))
      .then((value) => {
        tx.oncomplete = () => {
          db.close();
          resolve(value);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB transaction failed"));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        };
      })
      .catch((error) => {
        db.close();
        reject(error);
      });
  });
}

export async function appendCodexWasmJournalEntry(
  entry: CodexWasmJournalEntry,
): Promise<void> {
  if (!hasIndexedDb()) {
    inMemoryEntries.push(entry);
    return;
  }
  await withStore("readwrite", (store) => {
    store.put(entry);
  });
}

export async function queryCodexWasmJournalEntries(
  filter: CodexWasmJournalFilter = {},
): Promise<CodexWasmJournalEntry[]> {
  if (!hasIndexedDb()) {
    return filterCodexWasmJournalEntries(inMemoryEntries, filter);
  }
  const db = await openDatabase();
  if (!db) {
    return filterCodexWasmJournalEntries(inMemoryEntries, filter);
  }
  return await new Promise<CodexWasmJournalEntry[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      db.close();
      resolve(
        filterCodexWasmJournalEntries(
          (request.result as CodexWasmJournalEntry[]) ?? [],
          filter,
        ),
      );
    };
    request.onerror = () => {
      db.close();
      reject(request.error ?? new Error("Failed to read IndexedDB journal"));
    };
  });
}

function filterCodexWasmJournalEntries(
  entries: CodexWasmJournalEntry[],
  filter: CodexWasmJournalFilter,
): CodexWasmJournalEntry[] {
  return entries.filter((entry) => {
    if (filter.threadId && entry.threadId !== filter.threadId) {
      return false;
    }
    if (filter.turnId && entry.turnId !== filter.turnId) {
      return false;
    }
    if (typeof filter.sinceSeq === "number" && entry.seq < filter.sinceSeq) {
      return false;
    }
    return true;
  });
}

export async function resetCodexWasmJournalEntries(): Promise<void> {
  if (!hasIndexedDb()) {
    inMemoryEntries = [];
    return;
  }
  await withStore("readwrite", (store) => {
    store.clear();
  });
}
