import { v4 as uuidv4 } from "uuid";

import { getAppPath } from "../appBase";
import type { NotebookDiffDocument } from "./model";

const documents = new Map<string, NotebookDiffDocument>();

export function registerNotebookDiffDocument(
  document: Omit<NotebookDiffDocument, "id"> & { id?: string },
): NotebookDiffDocument {
  const id = document.id?.trim() || `notebook-diff-${uuidv4()}`;
  const stored = { ...document, id };
  documents.set(id, stored);
  return stored;
}

export function getNotebookDiffDocument(id: string): NotebookDiffDocument | null {
  return documents.get(id) ?? null;
}

export function openNotebookDiffDocument(
  document: NotebookDiffDocument | { id: string },
): void {
  const id = document.id.trim();
  if (!id) {
    throw new Error("openDiffTab requires a diff document id");
  }
  const path = getAppPath(`/diff/${encodeURIComponent(id)}`);
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

