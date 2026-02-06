import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { v4 as uuidv4 } from "uuid";

import { parser_pb } from "../runme/client";
import {
  NotebookStore,
  NotebookStoreItem,
  NotebookStoreItemType,
} from "./notebook";
import { FsDatabase, WorkspaceRecord } from "./fsdb";

// ---------------------------------------------------------------------------
// File System Access API type augmentations
// ---------------------------------------------------------------------------
// The File System Access API types are not fully covered by the default DOM
// lib. We declare the minimal surface we rely on so TypeScript is happy.

declare global {
  interface Window {
    showDirectoryPicker?: (
      options?: { mode?: "read" | "readwrite" },
    ) => Promise<FileSystemDirectoryHandle>;
  }

  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<
      [string, FileSystemFileHandle | FileSystemDirectoryHandle]
    >;
    requestPermission?(options?: {
      mode?: "read" | "readwrite";
    }): Promise<PermissionState>;
  }
}

// ---------------------------------------------------------------------------
// URI helpers
// ---------------------------------------------------------------------------

/**
 * Build an fs:// URI for a workspace entry.
 *
 * Format: `fs://workspace/<workspaceId>/file/<encodedRelativePath>`
 *     or: `fs://workspace/<workspaceId>/dir/<encodedRelativePath>`
 */
function buildFsUri(
  workspaceId: string,
  relativePath: string,
  kind: "file" | "directory",
): string {
  const prefix = kind === "file" ? "file" : "dir";
  const encoded = encodeURIComponent(relativePath);
  return `fs://workspace/${workspaceId}/${prefix}/${encoded}`;
}

/**
 * Build the root URI for a workspace directory.
 */
function buildWorkspaceRootUri(workspaceId: string): string {
  return `fs://workspace/${workspaceId}/dir/${encodeURIComponent("")}`;
}

interface ParsedFsUri {
  workspaceId: string;
  kind: "file" | "directory";
  relativePath: string;
}

function parseFsUri(uri: string): ParsedFsUri {
  if (!uri.startsWith("fs://workspace/")) {
    throw new Error(`Invalid filesystem URI: ${uri}`);
  }

  // fs://workspace/<workspaceId>/<file|dir>/<encodedPath>
  const withoutScheme = uri.slice("fs://workspace/".length);
  const slashIdx = withoutScheme.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`Invalid filesystem URI (missing kind segment): ${uri}`);
  }

  const workspaceId = withoutScheme.slice(0, slashIdx);
  const rest = withoutScheme.slice(slashIdx + 1);

  const kindSlash = rest.indexOf("/");
  if (kindSlash === -1) {
    throw new Error(
      `Invalid filesystem URI (missing path segment): ${uri}`,
    );
  }

  const kindStr = rest.slice(0, kindSlash);
  const encodedPath = rest.slice(kindSlash + 1);

  let kind: "file" | "directory";
  if (kindStr === "file") {
    kind = "file";
  } else if (kindStr === "dir") {
    kind = "directory";
  } else {
    throw new Error(`Invalid filesystem URI kind "${kindStr}": ${uri}`);
  }

  const relativePath = decodeURIComponent(encodedPath);

  // Path traversal protection: reject ".." segments.
  const segments = relativePath.split("/");
  if (segments.some((s) => s === ".." || s === ".")) {
    throw new Error(
      `Invalid filesystem URI (path traversal detected): ${uri}`,
    );
  }

  return {
    workspaceId,
    kind,
    relativePath,
  };
}

function entryRecordId(workspaceId: string, relativePath: string): string {
  return `${workspaceId}:${relativePath}`;
}

// ---------------------------------------------------------------------------
// Notebook helpers
// ---------------------------------------------------------------------------

function createEmptyNotebookJson(): string {
  const notebook = create(parser_pb.NotebookSchema, { cells: [] });
  return toJsonString(parser_pb.NotebookSchema, notebook, {
    emitDefaultValues: true,
  });
}

// ---------------------------------------------------------------------------
// Base revision tracking for conflict detection
// ---------------------------------------------------------------------------

interface BaseRevision {
  lastModified: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.showDirectoryPicker === "function"
  );
}

// ---------------------------------------------------------------------------
// FilesystemNotebookStore
// ---------------------------------------------------------------------------

/**
 * FilesystemNotebookStore implements `NotebookStore` using the browser
 * File System Access API. Notebooks are stored as `.json` files on the local
 * filesystem, and workspace/file handle metadata is cached in IndexedDB via
 * `FsDatabase`.
 *
 * URI scheme:
 *   fs://workspace/<workspaceId>/file/<encodedRelativePath>
 *   fs://workspace/<workspaceId>/dir/<encodedRelativePath>
 */
export class FilesystemNotebookStore implements NotebookStore {
  private readonly db: FsDatabase;

  /** In-memory base revision map keyed by entry record id. */
  private readonly baseRevisions = new Map<string, BaseRevision>();

  constructor(db?: FsDatabase) {
    this.db = db ?? new FsDatabase();
  }

  // -----------------------------------------------------------------------
  // Workspace management (not part of NotebookStore interface)
  // -----------------------------------------------------------------------

  /**
   * Open a directory via the File System Access API and register it as a
   * workspace. Returns the workspace root URI.
   */
  async openWorkspace(): Promise<string> {
    if (!isFileSystemAccessSupported()) {
      throw new Error(
        "File System Access API is not supported in this browser",
      );
    }

    const dirHandle = await window.showDirectoryPicker!({ mode: "readwrite" });
    const id = uuidv4();

    const record: WorkspaceRecord = {
      id,
      name: dirHandle.name,
      rootHandle: dirHandle,
      lastOpened: Date.now(),
      permissionState: "granted",
    };

    await this.db.workspaces.put(record);

    // Cache the root directory entry.
    await this.db.entries.put({
      id: entryRecordId(id, ""),
      workspaceId: id,
      relativePath: "",
      kind: "directory",
      handle: dirHandle,
      lastKnownMtime: 0,
      lastKnownSize: 0,
    });

    return buildWorkspaceRootUri(id);
  }

  /**
   * Re-request permission for a previously opened workspace. Returns `true`
   * if permission was granted.
   */
  async requestPermission(workspaceId: string): Promise<boolean> {
    const ws = await this.db.workspaces.get(workspaceId);
    if (!ws) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const state = await ws.rootHandle.requestPermission!({ mode: "readwrite" });
    await this.db.workspaces.update(workspaceId, {
      permissionState: state,
      lastOpened: Date.now(),
    });

    return state === "granted";
  }

  /**
   * List all known workspaces, ordered by most recently opened.
   */
  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return this.db.workspaces.orderBy("lastOpened").reverse().toArray();
  }

  // -----------------------------------------------------------------------
  // NotebookStore implementation
  // -----------------------------------------------------------------------

  async list(uri: string): Promise<NotebookStoreItem[]> {
    const parsed = parseFsUri(uri);
    if (parsed.kind !== "directory") {
      throw new Error("FilesystemNotebookStore.list expects a directory URI");
    }

    const dirHandle = await this.resolveDirectoryHandle(
      parsed.workspaceId,
      parsed.relativePath,
    );

    const items: NotebookStoreItem[] = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === "file") {
        if (!name.endsWith(".json")) {
          continue;
        }
        const relPath = parsed.relativePath
          ? `${parsed.relativePath}/${name}`
          : name;
        const childUri = buildFsUri(parsed.workspaceId, relPath, "file");

        // Cache the handle.
        const file = await (handle as FileSystemFileHandle).getFile();
        await this.db.entries.put({
          id: entryRecordId(parsed.workspaceId, relPath),
          workspaceId: parsed.workspaceId,
          relativePath: relPath,
          kind: "file",
          handle,
          lastKnownMtime: file.lastModified,
          lastKnownSize: file.size,
        });

        items.push({
          uri: childUri,
          name,
          type: NotebookStoreItemType.File,
          children: [],
          parents: [uri],
        });
      } else if (handle.kind === "directory") {
        const relPath = parsed.relativePath
          ? `${parsed.relativePath}/${name}`
          : name;
        const childUri = buildFsUri(parsed.workspaceId, relPath, "directory");

        await this.db.entries.put({
          id: entryRecordId(parsed.workspaceId, relPath),
          workspaceId: parsed.workspaceId,
          relativePath: relPath,
          kind: "directory",
          handle,
          lastKnownMtime: 0,
          lastKnownSize: 0,
        });

        items.push({
          uri: childUri,
          name,
          type: NotebookStoreItemType.Folder,
          children: [],
          parents: [uri],
        });
      }
    }

    // Sort alphabetically, folders first.
    items.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === NotebookStoreItemType.Folder ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return items;
  }

  async load(uri: string): Promise<parser_pb.Notebook> {
    const parsed = parseFsUri(uri);
    if (parsed.kind !== "file") {
      throw new Error("FilesystemNotebookStore.load expects a file URI");
    }

    const fileHandle = await this.resolveFileHandle(
      parsed.workspaceId,
      parsed.relativePath,
    );

    const file = await fileHandle.getFile();
    const text = await file.text();

    // Record base revision for conflict detection.
    const recId = entryRecordId(parsed.workspaceId, parsed.relativePath);
    this.baseRevisions.set(recId, {
      lastModified: file.lastModified,
      size: file.size,
    });

    // Update cached metadata.
    await this.db.entries.update(recId, {
      lastKnownMtime: file.lastModified,
      lastKnownSize: file.size,
      cachedDoc: text,
    });

    return fromJsonString(parser_pb.NotebookSchema, text, {
      ignoreUnknownFields: true,
    });
  }

  async save(uri: string, notebook: parser_pb.Notebook): Promise<void> {
    const parsed = parseFsUri(uri);
    if (parsed.kind !== "file") {
      throw new Error("FilesystemNotebookStore.save expects a file URI");
    }

    const fileHandle = await this.resolveFileHandle(
      parsed.workspaceId,
      parsed.relativePath,
    );

    // Conflict detection: compare current file stats to base revision.
    const recId = entryRecordId(parsed.workspaceId, parsed.relativePath);
    const baseRev = this.baseRevisions.get(recId);
    if (baseRev) {
      const currentFile = await fileHandle.getFile();
      if (
        currentFile.lastModified !== baseRev.lastModified ||
        currentFile.size !== baseRev.size
      ) {
        throw new Error(
          `Conflict detected for ${parsed.relativePath}: the file was modified externally since last load.`,
        );
      }
    }

    const json = toJsonString(parser_pb.NotebookSchema, notebook, {
      emitDefaultValues: true,
    });

    const writable = await fileHandle.createWritable();
    await writable.write(json);
    await writable.close();

    // Update base revision after successful write.
    const updatedFile = await fileHandle.getFile();
    this.baseRevisions.set(recId, {
      lastModified: updatedFile.lastModified,
      size: updatedFile.size,
    });

    await this.db.entries.update(recId, {
      lastKnownMtime: updatedFile.lastModified,
      lastKnownSize: updatedFile.size,
      cachedDoc: json,
    });
  }

  async create(parentUri: string, name: string): Promise<NotebookStoreItem> {
    const parsed = parseFsUri(parentUri);
    if (parsed.kind !== "directory") {
      throw new Error(
        "FilesystemNotebookStore.create expects a directory URI",
      );
    }

    // Ensure .json extension so the file will be visible via list().
    const safeName = name.endsWith(".json") ? name : `${name}.json`;

    const dirHandle = await this.resolveDirectoryHandle(
      parsed.workspaceId,
      parsed.relativePath,
    );

    const fileHandle = await dirHandle.getFileHandle(safeName, { create: true });

    // Write an empty notebook.
    const json = createEmptyNotebookJson();
    const writable = await fileHandle.createWritable();
    await writable.write(json);
    await writable.close();

    const relPath = parsed.relativePath
      ? `${parsed.relativePath}/${safeName}`
      : safeName;
    const fileUri = buildFsUri(parsed.workspaceId, relPath, "file");

    const file = await fileHandle.getFile();
    const recId = entryRecordId(parsed.workspaceId, relPath);

    await this.db.entries.put({
      id: recId,
      workspaceId: parsed.workspaceId,
      relativePath: relPath,
      kind: "file",
      handle: fileHandle,
      lastKnownMtime: file.lastModified,
      lastKnownSize: file.size,
      cachedDoc: json,
    });

    this.baseRevisions.set(recId, {
      lastModified: file.lastModified,
      size: file.size,
    });

    return {
      uri: fileUri,
      name: safeName,
      type: NotebookStoreItemType.File,
      children: [],
      parents: [parentUri],
    };
  }

  async rename(uri: string, name: string): Promise<NotebookStoreItem> {
    const parsed = parseFsUri(uri);
    if (parsed.kind !== "file") {
      throw new Error("FilesystemNotebookStore.rename expects a file URI");
    }

    // Ensure .json extension so the file remains visible via list().
    const safeName = name.endsWith(".json") ? name : `${name}.json`;

    // Read the old file contents.
    const fileHandle = await this.resolveFileHandle(
      parsed.workspaceId,
      parsed.relativePath,
    );
    const oldFile = await fileHandle.getFile();
    const content = await oldFile.text();

    // Determine parent directory.
    const segments = parsed.relativePath.split("/");
    const parentRelPath = segments.slice(0, -1).join("/");

    const dirHandle = await this.resolveDirectoryHandle(
      parsed.workspaceId,
      parentRelPath,
    );

    // Create the new file and write the contents.
    const newFileHandle = await dirHandle.getFileHandle(safeName, { create: true });
    const writable = await newFileHandle.createWritable();
    await writable.write(content);
    await writable.close();

    // Remove the old file.
    const oldName = segments[segments.length - 1];
    await dirHandle.removeEntry(oldName);

    // Clean up old entry record.
    const oldRecId = entryRecordId(parsed.workspaceId, parsed.relativePath);
    await this.db.entries.delete(oldRecId);
    this.baseRevisions.delete(oldRecId);

    // Register the new entry.
    const newRelPath = parentRelPath ? `${parentRelPath}/${safeName}` : safeName;
    const newUri = buildFsUri(parsed.workspaceId, newRelPath, "file");
    const newFile = await newFileHandle.getFile();
    const newRecId = entryRecordId(parsed.workspaceId, newRelPath);

    await this.db.entries.put({
      id: newRecId,
      workspaceId: parsed.workspaceId,
      relativePath: newRelPath,
      kind: "file",
      handle: newFileHandle,
      lastKnownMtime: newFile.lastModified,
      lastKnownSize: newFile.size,
      cachedDoc: content,
    });

    this.baseRevisions.set(newRecId, {
      lastModified: newFile.lastModified,
      size: newFile.size,
    });

    const parentUri = buildFsUri(
      parsed.workspaceId,
      parentRelPath,
      "directory",
    );

    return {
      uri: newUri,
      name: safeName,
      type: NotebookStoreItemType.File,
      children: [],
      parents: [parentUri],
    };
  }

  async getMetadata(uri: string): Promise<NotebookStoreItem | null> {
    const parsed = parseFsUri(uri);
    const recId = entryRecordId(parsed.workspaceId, parsed.relativePath);
    const entry = await this.db.entries.get(recId);

    if (!entry) {
      return null;
    }

    const type =
      entry.kind === "file"
        ? NotebookStoreItemType.File
        : NotebookStoreItemType.Folder;

    // Derive parent URI.
    const segments = parsed.relativePath.split("/").filter(Boolean);
    const parentRelPath = segments.slice(0, -1).join("/");
    const parentUri =
      segments.length > 0
        ? buildFsUri(parsed.workspaceId, parentRelPath, "directory")
        : buildWorkspaceRootUri(parsed.workspaceId);

    // Derive display name from the last path segment or workspace name.
    let displayName: string;
    if (parsed.relativePath === "") {
      const ws = await this.db.workspaces.get(parsed.workspaceId);
      displayName = ws?.name ?? parsed.workspaceId;
    } else {
      displayName = segments[segments.length - 1];
    }

    return {
      uri,
      name: displayName,
      type,
      children: [],
      parents: [parentUri],
    };
  }

  async getType(uri: string): Promise<NotebookStoreItemType> {
    const parsed = parseFsUri(uri);
    return parsed.kind === "file"
      ? NotebookStoreItemType.File
      : NotebookStoreItemType.Folder;
  }

  // -----------------------------------------------------------------------
  // Handle resolution helpers
  // -----------------------------------------------------------------------

  private async resolveFileHandle(
    workspaceId: string,
    relativePath: string,
  ): Promise<FileSystemFileHandle> {
    const recId = entryRecordId(workspaceId, relativePath);
    const entry = await this.db.entries.get(recId);
    if (entry && entry.kind === "file") {
      return entry.handle as FileSystemFileHandle;
    }

    // Walk from the workspace root.
    const ws = await this.db.workspaces.get(workspaceId);
    if (!ws) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const segments = relativePath.split("/").filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) {
      throw new Error(`Invalid file path: ${relativePath}`);
    }

    let dirHandle: FileSystemDirectoryHandle = ws.rootHandle;
    for (const segment of segments) {
      dirHandle = await dirHandle.getDirectoryHandle(segment);
    }

    const fileHandle = await dirHandle.getFileHandle(fileName);

    // Cache the resolved handle.
    await this.db.entries.put({
      id: recId,
      workspaceId,
      relativePath,
      kind: "file",
      handle: fileHandle,
      lastKnownMtime: 0,
      lastKnownSize: 0,
    });

    return fileHandle;
  }

  private async resolveDirectoryHandle(
    workspaceId: string,
    relativePath: string,
  ): Promise<FileSystemDirectoryHandle> {
    const recId = entryRecordId(workspaceId, relativePath);
    const entry = await this.db.entries.get(recId);
    if (entry && entry.kind === "directory") {
      return entry.handle as FileSystemDirectoryHandle;
    }

    const ws = await this.db.workspaces.get(workspaceId);
    if (!ws) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    if (!relativePath) {
      return ws.rootHandle;
    }

    const segments = relativePath.split("/").filter(Boolean);
    let dirHandle: FileSystemDirectoryHandle = ws.rootHandle;
    for (const segment of segments) {
      dirHandle = await dirHandle.getDirectoryHandle(segment);
    }

    // Cache.
    await this.db.entries.put({
      id: recId,
      workspaceId,
      relativePath,
      kind: "directory",
      handle: dirHandle,
      lastKnownMtime: 0,
      lastKnownSize: 0,
    });

    return dirHandle;
  }
}
