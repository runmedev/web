import type { NotebookStore } from "./notebook";

export function isContentsUri(uri: string): boolean {
  return uri.startsWith("contents://");
}

/**
 * Minimal store interface used by resolveStore callers (load, save, getMetadata).
 *
 * LocalNotebooks does not implement the full NotebookStore interface, so we
 * expose only the subset that callers actually need. ContentsNotebookStore
 * satisfies both this and NotebookStore.
 */
export type ResolvedStore = Pick<NotebookStore, "save" | "load" | "getMetadata">;

/**
 * Resolve the appropriate store for a given URI.
 *
 * - `contents://` URIs are routed to the ContentsNotebookStore.
 * - All other URIs (local://, gdrive://) fall through to the local store.
 */
export function resolveStore(
  uri: string,
  localStore: ResolvedStore | null,
  contentsStore: NotebookStore | null,
): ResolvedStore | null {
  if (isContentsUri(uri) && contentsStore) {
    return contentsStore;
  }
  return localStore;
}
