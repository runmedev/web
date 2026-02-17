import Dexie, { Table } from "dexie";

/**
 * WorkspaceRecord persists the association between a user-opened directory and
 * its File System Access API handle. Storing the handle in IndexedDB allows the
 * browser to re-request permission on subsequent visits without requiring the
 * user to re-pick the folder.
 */
export interface WorkspaceRecord {
  /** Stable identifier for the workspace (UUID). */
  id: string;
  /** User-friendly display name, typically the directory name. */
  name: string;
  /** The directory handle obtained from `showDirectoryPicker()`. */
  rootHandle: FileSystemDirectoryHandle;
  /** Epoch-millisecond timestamp of the most recent open. */
  lastOpened: number;
  /** Last known permission state for the handle: 'granted' | 'prompt' | 'denied'. */
  permissionState: string;
}

/**
 * FsEntryRecord caches metadata about individual files and directories within
 * an opened workspace. Keeping handles in IndexedDB lets us resolve files
 * without walking the full directory tree on every operation.
 */
export interface FsEntryRecord {
  /** Composite key: `${workspaceId}:${relativePath}`. */
  id: string;
  /** References the parent WorkspaceRecord. */
  workspaceId: string;
  /** POSIX-style path relative to the workspace root (e.g. "subdir/notebook.json"). */
  relativePath: string;
  /** Whether this entry is a file or directory. */
  kind: "file" | "directory";
  /** The File System Access API handle for this entry. */
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  /** Last-known modification time (epoch ms) from File.lastModified. */
  lastKnownMtime: number;
  /** Last-known byte size from File.size. */
  lastKnownSize: number;
  /** Optional cached notebook JSON for quick loads without hitting disk. */
  cachedDoc?: string;
}

/**
 * FsDatabase is a thin Dexie wrapper that defines the IndexedDB schema used by
 * FilesystemNotebookStore. It mirrors the approach used in `local.ts` for the
 * Drive-backed local cache.
 */
export class FsDatabase extends Dexie {
  workspaces!: Table<WorkspaceRecord, string>;
  entries!: Table<FsEntryRecord, string>;

  constructor(databaseName: string = "runme-fs-workspaces") {
    super(databaseName);

    this.version(1).stores({
      workspaces: "&id, name, lastOpened",
      entries: "&id, workspaceId, relativePath, kind",
    });

    this.workspaces = this.table("workspaces");
    this.entries = this.table("entries");
  }
}
