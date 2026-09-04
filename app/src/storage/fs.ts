import { v4 as uuidv4 } from 'uuid'

import { migrateNotebookCellIds } from '../lib/cellIdentity'
import { IPYNB_MIME_TYPE, type IpynbMergeState } from '../lib/ipynb'
import {
  RUNME_OPERATION_LOG_MIME_TYPE,
  createInitialNotebookFile,
  decodeNotebookFile,
  detectNotebookFileFormat,
  encodeIpynbNotebook,
  encodeRunmeNotebook,
  isNotebookFileName,
  notebookFileExtension,
  validateNotebookRenameFormat,
} from '../lib/notebookFormat'
import { parser_pb } from '../runme/client'
import { FsDatabase, WorkspaceRecord } from './fsdb'
import { NotebookStoreItem, NotebookStoreItemType } from './notebook'

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

function notebookNameForCreate(name: string): string {
  const trimmed = name.trim()
  if (detectNotebookFileFormat(trimmed)) {
    return trimmed
  }
  if (/\.[^/]+$/.test(trimmed)) {
    throw new Error(`Unsupported notebook file extension: ${name}`)
  }
  return `${trimmed}.json`
}

function notebookNameForRename(oldName: string, name: string): string {
  const oldFormat = detectNotebookFileFormat(oldName)
  if (!oldFormat) {
    throw new Error(`Unsupported notebook file extension: ${oldName}`)
  }
  const trimmed = name.trim()
  validateNotebookRenameFormat(oldName, trimmed)
  const nextFormat = detectNotebookFileFormat(trimmed)
  if (nextFormat) {
    return trimmed
  }
  return `${trimmed}${notebookFileExtension(oldFormat)}`
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

export class FilesystemEntryAlreadyExistsError extends Error {
  constructor(readonly fileName: string) {
    super(`A file named "${fileName}" already exists in this folder.`)
    this.name = 'FilesystemEntryAlreadyExistsError'
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'NotFoundError'
  )
}

const FILE_CREATE_LOCK_PREFIX = 'runme:filesystem-create:'
const fallbackCreateTails = new Map<string, Promise<void>>()

async function runFilesystemCreateExclusive<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const lockName = `${FILE_CREATE_LOCK_PREFIX}${key}`
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.locks?.request === 'function'
  ) {
    return navigator.locks.request(lockName, operation)
  }

  const previous = fallbackCreateTails.get(lockName) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  fallbackCreateTails.set(lockName, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (fallbackCreateTails.get(lockName) === tail) {
      fallbackCreateTails.delete(lockName)
    }
  }
}

// ---------------------------------------------------------------------------
// FilesystemNotebookStore
// ---------------------------------------------------------------------------

/**
 * FilesystemNotebookStore is the local filesystem adapter. The editor works
 * against LocalNotebooks; this class lists/loads/saves upstream files using the
 * File System Access API. Notebooks are stored as `.json` files on the local
 * filesystem, and workspace/file handle metadata is cached in IndexedDB via
 * `FsDatabase`.
 *
 * URI scheme:
 *   fs://workspace/<workspaceId>/file/<encodedRelativePath>
 *   fs://workspace/<workspaceId>/dir/<encodedRelativePath>
 */
export class FilesystemNotebookStore {
  private readonly db: FsDatabase;

  /** In-memory base revision map keyed by entry record id. */
  private readonly baseRevisions = new Map<string, BaseRevision>()
  private readonly ipynbState = new Map<
    string,
    { shadowText: string; state: IpynbMergeState }
  >()

  constructor(db?: FsDatabase) {
    this.db = db ?? new FsDatabase();
  }

  // -----------------------------------------------------------------------
  // Workspace management
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
  // File/directory operations
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
      if (handle.kind === 'file') {
        if (!isNotebookFileName(name)) {
          continue
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
          mimeType:
            detectNotebookFileFormat(name) === 'ipynb'
              ? IPYNB_MIME_TYPE
              : detectNotebookFileFormat(name) === 'runme-operation-log'
                ? RUNME_OPERATION_LOG_MIME_TYPE
                : 'application/json',
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

    const decoded = decodeNotebookFile(text, parsed.relativePath)
    const notebook = decoded.notebook
    if (decoded.ipynb) {
      this.ipynbState.set(recId, {
        shadowText: decoded.ipynb.shadowText,
        state: decoded.ipynb,
      })
    }
    return notebook
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

    migrateNotebookCellIds(notebook)
    let json: string
    if (detectNotebookFileFormat(parsed.relativePath) === 'ipynb') {
      let preservation = this.ipynbState.get(recId)
      if (!preservation) {
        const currentText = await (await fileHandle.getFile()).text()
        const decoded = decodeNotebookFile(currentText, parsed.relativePath)
        preservation = decoded.ipynb
          ? { shadowText: decoded.ipynb.shadowText, state: decoded.ipynb }
          : undefined
      }
      const encoded = encodeIpynbNotebook(
        notebook,
        preservation?.shadowText,
        preservation?.state
      )
      json = encoded.text
      this.ipynbState.set(recId, {
        shadowText: json,
        state: encoded.state,
      })
    } else {
      json = encodeRunmeNotebook(notebook)
    }

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
    const safeName = notebookNameForCreate(name)
    return this.createFileWithContent(
      parentUri,
      safeName,
      createInitialNotebookFile(safeName),
      'create'
    )
  }

  async createContent(
    parentUri: string,
    name: string,
    content: string
  ): Promise<NotebookStoreItem> {
    const safeName = notebookNameForCreate(name)
    decodeNotebookFile(content, safeName)
    return this.createFileWithContent(
      parentUri,
      safeName,
      content,
      'createContent'
    )
  }

  private async createFileWithContent(
    parentUri: string,
    safeName: string,
    content: string,
    operation: 'create' | 'createContent'
  ): Promise<NotebookStoreItem> {
    const parsed = parseFsUri(parentUri);
    if (parsed.kind !== "directory") {
      throw new Error(
        `FilesystemNotebookStore.${operation} expects a directory URI`,
      );
    }
    const relPath = parsed.relativePath
      ? `${parsed.relativePath}/${safeName}`
      : safeName
    const recId = entryRecordId(parsed.workspaceId, relPath)
    const createLockKey = await this.physicalEntryLockKey(
      parsed.workspaceId,
      relPath
    )

    return runFilesystemCreateExclusive(createLockKey, async () => {
      const dirHandle = await this.resolveDirectoryHandle(
        parsed.workspaceId,
        parsed.relativePath,
      );

      try {
        await dirHandle.getFileHandle(safeName)
        throw new FilesystemEntryAlreadyExistsError(safeName)
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error
        }
      }

      const fileHandle = await dirHandle.getFileHandle(safeName, {
        create: true,
      })
      try {
        const writable = await fileHandle.createWritable()
        await writable.write(content)
        await writable.close()

        const fileUri = buildFsUri(parsed.workspaceId, relPath, "file");
        const file = await fileHandle.getFile();

        await this.db.entries.put({
          id: recId,
          workspaceId: parsed.workspaceId,
          relativePath: relPath,
          kind: "file",
          handle: fileHandle,
          lastKnownMtime: file.lastModified,
          lastKnownSize: file.size,
          cachedDoc: content,
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
          mimeType:
            detectNotebookFileFormat(safeName) === 'ipynb'
              ? IPYNB_MIME_TYPE
              : detectNotebookFileFormat(safeName) === 'runme-operation-log'
                ? RUNME_OPERATION_LOG_MIME_TYPE
                : 'application/json',
          parents: [parentUri],
        };
      } catch (error) {
        await dirHandle.removeEntry(safeName).catch(() => {})
        throw error
      }
    })
  }

  /**
   * Use the same create lock for every workspace path that names one physical
   * entry. Besides identical root aliases, mounted roots can overlap (for
   * example, one workspace may open a subdirectory of another workspace).
   * Express the target relative to every registered ancestor/descendant root
   * and choose the same stable key from that equivalent set.
   */
  private async physicalEntryLockKey(
    workspaceId: string,
    relativePath: string
  ): Promise<string> {
    const workspace = await this.db.workspaces.get(workspaceId)
    if (!workspace) return entryRecordId(workspaceId, relativePath)

    const equivalentEntryIds = [entryRecordId(workspaceId, relativePath)]
    for (const candidate of await this.db.workspaces.toArray()) {
      if (candidate.id === workspaceId) continue
      try {
        if (await workspace.rootHandle.isSameEntry(candidate.rootHandle)) {
          equivalentEntryIds.push(entryRecordId(candidate.id, relativePath))
          continue
        }

        const candidateBelowWorkspace = await workspace.rootHandle.resolve(
          candidate.rootHandle
        )
        if (candidateBelowWorkspace) {
          const candidatePrefix = candidateBelowWorkspace.join('/')
          if (relativePath === candidatePrefix) {
            equivalentEntryIds.push(entryRecordId(candidate.id, ''))
          } else if (relativePath.startsWith(`${candidatePrefix}/`)) {
            equivalentEntryIds.push(
              entryRecordId(
                candidate.id,
                relativePath.slice(candidatePrefix.length + 1)
              )
            )
          }
          continue
        }

        const workspaceBelowCandidate = await candidate.rootHandle.resolve(
          workspace.rootHandle
        )
        if (workspaceBelowCandidate) {
          equivalentEntryIds.push(
            entryRecordId(
              candidate.id,
              [...workspaceBelowCandidate, relativePath]
                .filter(Boolean)
                .join('/')
            )
          )
        }
      } catch {
        // A stale or revoked overlapping root cannot provide shared identity.
      }
    }
    equivalentEntryIds.sort()
    return equivalentEntryIds[0]
  }

  async rename(uri: string, name: string): Promise<NotebookStoreItem> {
    const parsed = parseFsUri(uri);
    if (parsed.kind !== "file") {
      throw new Error("FilesystemNotebookStore.rename expects a file URI");
    }

    const oldName = parsed.relativePath.split('/').at(-1) ?? parsed.relativePath
    const safeName = notebookNameForRename(oldName, name)

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
    const oldEntryName = segments[segments.length - 1]
    await dirHandle.removeEntry(oldEntryName)

    // Clean up old entry record.
    const oldRecId = entryRecordId(parsed.workspaceId, parsed.relativePath)
    await this.db.entries.delete(oldRecId)
    this.baseRevisions.delete(oldRecId)
    const preservation = this.ipynbState.get(oldRecId)
    this.ipynbState.delete(oldRecId)

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
    })
    if (preservation) {
      this.ipynbState.set(newRecId, preservation)
    }

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
      mimeType: safeName.toLowerCase().endsWith('.ipynb')
        ? IPYNB_MIME_TYPE
        : 'application/json',
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
      mimeType:
        type === NotebookStoreItemType.File
          ? detectNotebookFileFormat(displayName) === 'ipynb'
            ? IPYNB_MIME_TYPE
            : detectNotebookFileFormat(displayName) === 'runme-operation-log'
              ? RUNME_OPERATION_LOG_MIME_TYPE
              : 'application/json'
          : undefined,
      parents: [parentUri],
    };
  }

  async loadContent(uri: string): Promise<string> {
    const parsed = parseFsUri(uri)
    if (parsed.kind !== 'file') {
      throw new Error('FilesystemNotebookStore.loadContent expects a file URI')
    }
    const handle = await this.resolveFileHandle(
      parsed.workspaceId,
      parsed.relativePath
    )
    const file = await handle.getFile()
    const recId = entryRecordId(parsed.workspaceId, parsed.relativePath)
    // Raw operation-log sync uses loadContent followed by saveContent as a
    // compare-and-swap pair. Capture the exact revision that was read so an
    // external write during the merge is rejected without overwriting it.
    this.baseRevisions.set(recId, {
      lastModified: file.lastModified,
      size: file.size,
    })
    return file.text()
  }

  async saveContent(uri: string, content: string): Promise<void> {
    const parsed = parseFsUri(uri)
    if (parsed.kind !== 'file') {
      throw new Error('FilesystemNotebookStore.saveContent expects a file URI')
    }
    const handle = await this.resolveFileHandle(
      parsed.workspaceId,
      parsed.relativePath
    )
    const recId = entryRecordId(parsed.workspaceId, parsed.relativePath)
    const decoded =
      detectNotebookFileFormat(parsed.relativePath) === 'ipynb'
        ? decodeNotebookFile(content, parsed.relativePath)
        : undefined
    const baseRevision = this.baseRevisions.get(recId)
    if (baseRevision) {
      const current = await handle.getFile()
      if (
        current.lastModified !== baseRevision.lastModified ||
        current.size !== baseRevision.size
      ) {
        throw new Error(
          `Conflict detected for ${parsed.relativePath}: the file was modified externally since last load.`
        )
      }
    }
    const writable = await handle.createWritable()
    await writable.write(content)
    await writable.close()
    const updated = await handle.getFile()
    this.baseRevisions.set(recId, {
      lastModified: updated.lastModified,
      size: updated.size,
    })
    await this.db.entries.update(recId, {
      lastKnownMtime: updated.lastModified,
      lastKnownSize: updated.size,
      cachedDoc: content,
    })
    if (decoded?.ipynb) {
      this.ipynbState.set(recId, {
        shadowText: decoded.ipynb.shadowText,
        state: decoded.ipynb,
      })
    }
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
