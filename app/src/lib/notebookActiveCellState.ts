export type CellFocusRole = "editor" | "rendered";

export type NotebookActiveCellState = {
  refId: string;
  focusRole: CellFocusRole;
  updatedAt: string;
};

export type NotebookActiveCellMap = Record<string, NotebookActiveCellState>;

const STORAGE_KEY = "runme/notebook-active-cells";

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFocusRole(value: unknown): CellFocusRole {
  return value === "rendered" ? "rendered" : "editor";
}

function normalizeEntry(value: unknown): NotebookActiveCellState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<NotebookActiveCellState>;
  const refId = normalizeString(candidate.refId);
  if (!refId) {
    return null;
  }
  return {
    refId,
    focusRole: normalizeFocusRole(candidate.focusRole),
    updatedAt: normalizeString(candidate.updatedAt),
  };
}

export function loadNotebookActiveCellMap(): NotebookActiveCellMap {
  if (typeof window === "undefined" || !window.localStorage) {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const next: NotebookActiveCellMap = {};
    for (const [docUri, entry] of Object.entries(parsed)) {
      const normalizedDocUri = normalizeString(docUri);
      if (!normalizedDocUri) {
        continue;
      }
      const normalizedEntry = normalizeEntry(entry);
      if (!normalizedEntry) {
        continue;
      }
      next[normalizedDocUri] = normalizedEntry;
    }
    return next;
  } catch {
    return {};
  }
}

export function persistNotebookActiveCellMap(
  snapshot: NotebookActiveCellMap,
): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    const next: NotebookActiveCellMap = {};
    for (const [docUri, entry] of Object.entries(snapshot)) {
      const normalizedDocUri = normalizeString(docUri);
      if (!normalizedDocUri) {
        continue;
      }
      const normalizedEntry = normalizeEntry(entry);
      if (!normalizedEntry) {
        continue;
      }
      next[normalizedDocUri] = normalizedEntry;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore localStorage write failures; focus restore should degrade safely.
  }
}

export function createNotebookActiveCellState(
  refId: string,
  focusRole: CellFocusRole,
): NotebookActiveCellState | null {
  const normalizedRefId = normalizeString(refId);
  if (!normalizedRefId) {
    return null;
  }
  return {
    refId: normalizedRefId,
    focusRole: normalizeFocusRole(focusRole),
    updatedAt: new Date().toISOString(),
  };
}
