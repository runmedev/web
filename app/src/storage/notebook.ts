export enum NotebookStoreItemType {
  File = "file",
  Folder = "folder",
}

export interface NotebookStoreItem {
  uri: string;
  name: string;
  type: NotebookStoreItemType;
  children: string[];
  remoteUri?: string;
  parents: string[];
}

/**
 * Result returned by save() when a conflict is detected.
 * Stores that don't support conflict detection return `{ conflicted: false }`.
 */
export interface ConflictResult {
  conflicted: boolean;
  conflictFileName?: string;
}
