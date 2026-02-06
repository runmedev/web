import type { NotebookStore } from "./notebook";

export function isContentsUri(uri: string): boolean {
  return uri.startsWith("contents://");
}

/**
 * Resolve the appropriate NotebookStore for a given URI.
 *
 * - `contents://` URIs are routed to the ContentsNotebookStore.
 * - All other URIs (local://, gdrive://) fall through to the local store.
 *
 * The `localStore` parameter is typed loosely so both LocalNotebooks (which has
 * save/load/getMetadata but does not implement the full NotebookStore interface)
 * and any NotebookStore can be passed. The unsafe cast is a known trade-off:
 * LocalNotebooks.save() returns Promise<void> while NotebookStore.save() returns
 * Promise<ConflictResult>, so a full type-safe solution requires refactoring
 * LocalNotebooks to implement NotebookStore.
 */
export function resolveStore(
  uri: string,
  localStore: { save(...args: unknown[]): Promise<unknown>; load(...args: unknown[]): Promise<unknown>; getMetadata(...args: unknown[]): Promise<unknown> } | null,
  contentsStore: NotebookStore | null,
): NotebookStore | null {
  if (isContentsUri(uri) && contentsStore) {
    return contentsStore;
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return localStore as unknown as NotebookStore | null;
}
