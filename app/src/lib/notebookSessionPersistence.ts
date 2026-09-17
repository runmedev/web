import { NotebookStoreItem, NotebookStoreItemType } from "../storage/notebook";
import {
  type DurableNotebookSession,
  MAX_SESSION_BYTES,
  SESSION_RECORD_PREFIX,
  SESSION_RETENTION_MS,
  collectInactiveNotebookSessions,
  getDurableSessionStorage,
  parseDurableSession,
} from "./durableNotebookSessions";
import { appLogger } from "./logging/runtime";
import type { OpenNotebookEntry } from "./notebookDataController";
import {
  clearSessionRestoreState,
  consumeStaleSessionRestoreCache,
  getClaimedSessionId,
  hasSessionLock,
} from "./tabIdentity";

const CURRENT_DOC_STORAGE_KEY = "runme/currentDoc";
const OPEN_NOTEBOOKS_STORAGE_KEY = "runme/openNotebooks";

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function normalizeStoredOpenNotebook(item: unknown): OpenNotebookEntry | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const candidate = item as Partial<NotebookStoreItem & OpenNotebookEntry>;
  if (typeof candidate.uri !== "string" || candidate.uri.trim() === "") {
    return null;
  }
  if (
    "type" in candidate &&
    candidate.type !== undefined &&
    candidate.type !== NotebookStoreItemType.File
  ) {
    return null;
  }
  return {
    uri: candidate.uri,
    requestedUri: candidate.requestedUri ?? candidate.uri,
    name: candidate.name ?? candidate.uri,
    state: "loading",
  };
}

function parseOpenNotebooks(raw: string | null): OpenNotebookEntry[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(normalizeStoredOpenNotebook)
      .filter((item): item is OpenNotebookEntry => Boolean(item));
  } catch {
    return [];
  }
}

/**
 * NotebookSessionPersistence stores per-tab restore state.
 *
 * Runtime state still lives in `CurrentDocContext` and
 * `NotebookDataController`; this class only hydrates them on startup and saves
 * snapshots after changes. Startup enables a durable record only after owning
 * the session Web Lock. sessionStorage remains a migration/fallback cache.
 */
export class NotebookSessionPersistence {
  private durable: {
    id: string;
    storage: Storage;
    record: DurableNotebookSession;
  } | null = null;
  private warned = false;

  /** Must finish before React/controller hydration; never persist an empty startup. */
  enableDurable(id: string): void {
    const staleCache = consumeStaleSessionRestoreCache();
    if (!hasSessionLock()) return;
    const storage = getDurableSessionStorage();
    if (!storage) return;
    try {
      const raw = storage.getItem(SESSION_RECORD_PREFIX + id);
      const existing = parseDurableSession(raw);
      if (raw !== null && !existing) {
        this.warnPersistence();
        return; // Preserve damaged bytes while the tab can still open notebooks.
      }
      // Returning from BFCache may follow another owner's edits. Once a valid
      // durable snapshot is available, discard all stale local restore hints.
      // Without a usable snapshot, preserve the existing ephemeral fallback.
      if (staleCache && existing) clearSessionRestoreState();
      const expired =
        existing && Date.now() - existing.lastActiveAt > SESSION_RETENTION_MS;
      const record: DurableNotebookSession =
        existing && !expired
          ? existing
          : {
              version: 1,
              lastActiveAt: Date.now(),
              currentDoc: expired ? null : this.loadCurrentDoc(),
              openNotebooks: expired
                ? []
                : this.loadOpenNotebooks().map(
                    ({ uri, requestedUri, name }) => ({
                      uri,
                      requestedUri,
                      name,
                    }),
                  ),
            };
      // A real reload keeps tab-local state; URL-only recreation needs the
      // durable fallback. This also migrates updates from an older app build.
      if (!expired) {
        const session = getSessionStorage();
        if (session?.getItem(CURRENT_DOC_STORAGE_KEY) != null)
          record.currentDoc = this.loadCurrentDoc();
        if (session?.getItem(OPEN_NOTEBOOKS_STORAGE_KEY) != null)
          record.openNotebooks = this.loadOpenNotebooks().map(
            ({ uri, requestedUri, name }) => ({ uri, requestedUri, name }),
          );
      }
      if (expired) getSessionStorage()?.removeItem("runme/workspaceDocuments");
      this.durable = { id, storage, record };
      this.touch();
    } catch {
      this.warnPersistence();
    }
  }

  /** Refresh the retention timestamp while active, including an unchanged workspace. */
  touch(): void {
    if (!this.durable || !hasSessionLock()) return;
    this.durable.record.lastActiveAt = Date.now();
    try {
      const raw = JSON.stringify(this.durable.record);
      if (raw.length * 2 > MAX_SESSION_BYTES) {
        this.warnPersistence();
        return; // Never silently truncate the user's open list.
      }
      this.durable.storage.setItem(
        SESSION_RECORD_PREFIX + this.durable.id,
        raw,
      );
    } catch {
      this.warnPersistence();
    }
  }

  private warnPersistence(): void {
    if (this.warned) return;
    this.warned = true;
    appLogger.warn(
      "Notebook session could not be saved for app restart recovery",
      {
        attrs: {
          scope: "notebook-session",
          code: "SESSION_PERSISTENCE_UNAVAILABLE",
        },
      },
    );
  }

  loadCurrentDoc(): string | null {
    if (this.durable) return this.durable.record.currentDoc;
    const session = getSessionStorage();
    const fromSession = session?.getItem(CURRENT_DOC_STORAGE_KEY);
    if (fromSession !== undefined && fromSession !== null) {
      return fromSession.trim() || null;
    }
    return null;
  }

  saveCurrentDoc(uri: string | null): void {
    if (this.durable) {
      this.durable.record.currentDoc = uri;
      this.touch();
    }
    const session = getSessionStorage();
    if (!session) {
      return;
    }
    try {
      if (!uri) {
        session.setItem(CURRENT_DOC_STORAGE_KEY, "");
        return;
      }
      session.setItem(CURRENT_DOC_STORAGE_KEY, uri);
    } catch {
      // Ignore restore persistence failures. Live state has already changed.
    }
  }

  loadOpenNotebooks(): OpenNotebookEntry[] {
    if (this.durable)
      return this.durable.record.openNotebooks.map((item) => ({
        ...item,
        state: "loading",
      }));
    const session = getSessionStorage();
    const fromSession = session?.getItem(OPEN_NOTEBOOKS_STORAGE_KEY);
    if (fromSession !== undefined && fromSession !== null) {
      return parseOpenNotebooks(fromSession);
    }
    return [];
  }

  saveOpenNotebooks(entries: OpenNotebookEntry[]): void {
    if (this.durable) {
      this.durable.record.openNotebooks = entries.map(
        ({ uri, requestedUri, name }) => ({ uri, requestedUri, name }),
      );
      this.touch();
    }
    const session = getSessionStorage();
    if (!session) {
      return;
    }
    try {
      session.setItem(OPEN_NOTEBOOKS_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Ignore restore persistence failures. Live state has already changed.
    }
  }
}

let persistence: NotebookSessionPersistence = new NotebookSessionPersistence();

export function getNotebookSessionPersistence(): NotebookSessionPersistence {
  return persistence;
}

export function __setNotebookSessionPersistenceForTests(
  next: NotebookSessionPersistence,
): void {
  persistence = next;
}

export function __resetNotebookSessionPersistenceForTests(): void {
  persistence = new NotebookSessionPersistence();
}

/** Bootstrap once before any notebook controller or React provider reads restore state. */
export async function initializeNotebookSessionPersistence(): Promise<void> {
  const id = await getClaimedSessionId();
  persistence.enableDurable(id);
  const storage = getDurableSessionStorage();
  if (!hasSessionLock() || !storage) return;
  const collect = () => {
    void collectInactiveNotebookSessions(storage, navigator.locks).catch(() => {
      appLogger.warn("Notebook session cleanup deferred", {
        attrs: { scope: "notebook-session", code: "SESSION_CLEANUP_DEFERRED" },
      });
    });
  };
  collect();
  const heartbeat = window.setInterval(() => persistence.touch(), 60_000);
  const cleanup = window.setInterval(collect, 60 * 60_000);
  window.addEventListener(
    "pagehide",
    () => {
      window.clearInterval(heartbeat);
      window.clearInterval(cleanup);
    },
    { once: true },
  );
}
