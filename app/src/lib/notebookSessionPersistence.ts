import {
  NotebookStoreItem,
  NotebookStoreItemType,
} from "../storage/notebook";
import type { OpenNotebookEntry } from "./notebookDataController";

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
 * snapshots after changes. It only uses sessionStorage so same-origin tabs can
 * diverge.
 */
export class NotebookSessionPersistence {
  loadCurrentDoc(): string | null {
    const session = getSessionStorage();
    const fromSession = session?.getItem(CURRENT_DOC_STORAGE_KEY);
    if (fromSession !== undefined && fromSession !== null) {
      return fromSession.trim() || null;
    }
    return null;
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
    return [];
  }

  saveOpenNotebooks(entries: OpenNotebookEntry[]): void {
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
