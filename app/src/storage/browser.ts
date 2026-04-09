import type { NotebookStoreItem } from "./notebook";

/**
 * Minimal storage facade used by the workspace explorer to render and mutate a
 * storage backend's file tree.
 *
 * This is the "can the user browse this storage system?" contract. Backends
 * that satisfy it can be shown in WorkspaceExplorer as folder/file trees,
 * regardless of whether the backend is the local IndexedDB mirror
 * (LocalNotebooks) or an upstream folder source (FilesystemNotebookStore).
 *
 * It is deliberately not the notebook editor's persistence API: keep
 * notebook-content load/save out of this interface. When the user opens an
 * upstream fs:// file, NotebookContext loads that upstream notebook once,
 * mirrors it into LocalNotebooks, and switches the editor to the resulting
 * local://file/... URI.
 */
export interface StorageBrowser {
  list(uri: string): Promise<NotebookStoreItem[]>;
  getMetadata(uri: string): Promise<NotebookStoreItem | null>;
  create(parentUri: string, name: string): Promise<NotebookStoreItem>;
  rename(uri: string, name: string): Promise<NotebookStoreItem>;
}
