import {
  NotebookStoreItem,
  NotebookStoreItemType,
} from "../storage/notebook";
import type { OpenNotebookEntry } from "./notebookDataController";

const CURRENT_DOC_STORAGE_KEY = "runme/currentDoc";
const OPEN_NOTEBOOKS_STORAGE_KEY = "runme/openNotebooks";
const LEGACY_OPEN_NOTEBOOKS_STORAGE_KEY = "aisre/openNotebooks";

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

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
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
    state: candidate.state ?? "loading",
    errorMessage: candidate.errorMessage,
    owner: candidate.owner,
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
 * snapshots after changes. It reads legacy localStorage keys as an initial
 * import path but only writes sessionStorage so same-origin tabs can diverge.
 */
export class NotebookSessionPersistence {
  loadCurrentDoc(): string | null {
    const session = getSessionStorage();
    const fromSession = session?.getItem(CURRENT_DOC_STORAGE_KEY);
    if (fromSession !== undefined && fromSession !== null) {
      return fromSession.trim() || null;
    }
    const local = getLocalStorage();
    const fromLegacy = local?.getItem(CURRENT_DOC_STORAGE_KEY)?.trim() || null;
    if (fromLegacy) {
      this.saveCurrentDoc(fromLegacy);
      try {
        local?.removeItem(CURRENT_DOC_STORAGE_KEY);
      } catch {
        // Ignore legacy cleanup failures. The migrated session value is usable.
      }
    }
    return fromLegacy;
  }

  saveCurrentDoc(uri: string | null): void {
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
    const session = getSessionStorage();
    const fromSession = session?.getItem(OPEN_NOTEBOOKS_STORAGE_KEY);
    if (fromSession !== undefined && fromSession !== null) {
      return parseOpenNotebooks(fromSession);
    }

    const local = getLocalStorage();
    const fromLegacy = parseOpenNotebooks(
      local?.getItem(OPEN_NOTEBOOKS_STORAGE_KEY) ??
        local?.getItem(LEGACY_OPEN_NOTEBOOKS_STORAGE_KEY) ??
        null,
    );
    if (fromLegacy.length > 0) {
      this.saveOpenNotebooks(fromLegacy);
      try {
        local?.removeItem(OPEN_NOTEBOOKS_STORAGE_KEY);
        local?.removeItem(LEGACY_OPEN_NOTEBOOKS_STORAGE_KEY);
      } catch {
        // Ignore legacy cleanup failures. The migrated session value is usable.
      }
    }
    return fromLegacy;
  }

  saveOpenNotebooks(entries: OpenNotebookEntry[]): void {
    const session = getSessionStorage();
    if (!session) {
      return;
    }
    try {
      session.setItem(OPEN_NOTEBOOKS_STORAGE_KEY, JSON.stringify(entries));
      session.removeItem(LEGACY_OPEN_NOTEBOOKS_STORAGE_KEY);
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
