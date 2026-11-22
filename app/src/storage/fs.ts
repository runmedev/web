import md5 from 'md5'
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
export function buildFsUri(
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
export function buildWorkspaceRootUri(workspaceId: string): string {
  return `fs://workspace/${workspaceId}/dir/${encodeURIComponent("")}`;
}

interface ParsedFsUri {
  workspaceId: string;
  kind: "file" | "directory";
  relativePath: string;
}

export function parseFsUri(uri: string): ParsedFsUri {
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

/**
 * Canonicalize only the coordination key, never the actual filesystem path.
 * This safely over-serializes case-distinct creates on case-sensitive volumes
 * while preventing overwrite races where the underlying volume ignores case.
 */
function physicalEntryLockId(
  workspaceId: string,
  relativePath: string
): string {
  return entryRecordId(workspaceId, relativePath.normalize('NFC').toLowerCase())
}

// ---------------------------------------------------------------------------
// Notebook helpers
// ---------------------------------------------------------------------------

function notebookNameForCreate(name: string): string {
  const trimmed = name.trim()
  if (detectNotebookFileFormat(trimmed) === 'runme-operation-log') {
    return trimmed
  }
  if (/\.[^/]+$/.test(trimmed)) {
    throw new Error(`Unsupported notebook file extension: ${name}`)
  }
  return `${trimmed}.runme`
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
  checksum?: string;
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

async function runFilesystemExclusive<T>(
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
 * File System Access API. Notebooks are stored as `.runme` files on the local
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
    return this.mountDirectory(dirHandle)
  }

  async mountDirectory(dirHandle: FileSystemDirectoryHandle): Promise<string> {
    const register = async () => {
      for (const workspace of await this.listWorkspaces()) {
        if (await dirHandle.isSameEntry?.(workspace.rootHandle)) {
          await this.db.workspaces.update(workspace.id, {
            rootHandle: dirHandle, name: dirHandle.name, mounted: true,
            lastOpened: Date.now(), permissionState: 'granted',
          })
          return buildWorkspaceRootUri(workspace.id)
        }
      }
      return this.registerWorkspace(dirHandle)
    }
    return runFilesystemExclusive('register-workspace', register)
  }

  /** Persist the handle before publishing the mount URI to the explorer. */
  private async registerWorkspace(dirHandle: FileSystemDirectoryHandle): Promise<string> {
    const id = uuidv4();

    const record: WorkspaceRecord = {
      id,
      name: dirHandle.name,
      rootHandle: dirHandle,
      lastOpened: Date.now(),
      permissionState: "granted",
      mounted: true,
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
      rootHandle: ws.rootHandle,
      permissionState: state,
      lastOpened: Date.now(),
    });

    return state === "granted";
  }

  /** Adopt only legacy roots still present in the saved explorer configuration. */
  async restoreWorkspace(uri: string): Promise<void> {
    const { workspaceId } = parseFsUri(uri)
    await this.db.transaction('rw', this.db.workspaces, async () => {
      const ws = await this.db.workspaces.get(workspaceId)
      if (ws && ws.mounted === undefined) await this.db.workspaces.put({ ...ws, mounted: true })
    })
  }

  /** Retain the handle and mirrors so reconnect can restore the same identities. */
  async unmount(uri: string): Promise<void> {
    const ws = await this.db.workspaces.get(parseFsUri(uri).workspaceId)
    if (ws) await this.db.workspaces.update(ws.id, { mounted: false, rootHandle: ws.rootHandle })
  }

  /** List known workspaces, most recently opened first. */
  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return this.db.workspaces.orderBy("lastOpened").reverse().toArray();
  }

  // -----------------------------------------------------------------------
  // File/directory operations
  // -----------------------------------------------------------------------

  async list(uri: string, signal?: AbortSignal): Promise<NotebookStoreItem[]> {
    const parsed = parseFsUri(uri);
    if (parsed.kind !== "directory") {
      throw new Error("FilesystemNotebookStore.list expects a directory URI");
    }

    const cacheId = entryRecordId(parsed.workspaceId, parsed.relativePath)
    try {
      const items = await this.listDirectory(uri, parsed, signal)
      if (!signal?.aborted) await this.db.entries.update(cacheId, { listedChildren: items })
      return items
    } catch (error) {
      if ((error as DOMException).name !== 'NotAllowedError') throw error
      const cached = await this.db.entries.get(cacheId)
      if (!cached?.listedChildren) throw error
      return cached.listedChildren.filter((child) => child.type === NotebookStoreItemType.Folder || detectNotebookFileFormat(child.name) === 'runme-operation-log')
    }
  }

  private async listDirectory(uri: string, parsed: ParsedFsUri, signal?: AbortSignal): Promise<NotebookStoreItem[]> {
    const dirHandle = await this.resolveDirectoryHandle(
      parsed.workspaceId,
      parsed.relativePath,
    );

    const items: NotebookStoreItem[] = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (signal?.aborted) break;
      if (handle.kind === 'file') {
        if (detectNotebookFileFormat(name) !== 'runme-operation-log') {
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
          mimeType: RUNME_OPERATION_LOG_MIME_TYPE,
          parents: [uri],
        });
      } else if (handle.kind === "directory") {
        const relPath = parsed.relativePath
          ? `${parsed.relativePath}/${name}`
          : name;
        const childUri = buildFsUri(parsed.workspaceId, relPath, "directory");

        const dirId = entryRecordId(parsed.workspaceId, relPath)
        const previous = await this.db.entries.get(dirId)
        await this.db.entries.put({
          listedChildren: previous?.listedChildren,
          id: dirId,
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
      checksum: md5(text),
    });

    // Update cached metadata.
    await this.db.entries.update(recId, {
      lastKnownMtime: file.lastModified,
      lastKnownSize: file.size,
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

    const recId = entryRecordId(parsed.workspaceId, parsed.relativePath)
    const baseRevision = this.baseRevisions.get(recId)
    migrateNotebookCellIds(notebook)
    if (detectNotebookFileFormat(parsed.relativePath) === 'ipynb') {
      let preservation = this.ipynbState.get(recId)
      if (!preservation) {
        const fileHandle = await this.resolveFileHandle(parsed.workspaceId, parsed.relativePath)
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
      await this.writeContent(parsed, encoded.text, baseRevision)
      this.ipynbState.set(recId, { shadowText: encoded.text, state: encoded.state })
      return
    }
    await this.writeContent(parsed, encodeRunmeNotebook(notebook), baseRevision)
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

    return runFilesystemExclusive(createLockKey, async () => {
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
      // The File System Access API has no exclusive-create flag. A process
      // outside this origin can therefore create the target after the probe
      // above but before getFileHandle resolves. A newly created file is
      // empty, so refuse a returned handle that already contains data rather
      // than overwriting the external file.
      const initialFile = await fileHandle.getFile()
      if (initialFile.size !== 0) {
        throw new FilesystemEntryAlreadyExistsError(safeName)
      }
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
          mimeType: detectNotebookFileFormat(safeName) === 'ipynb' ? IPYNB_MIME_TYPE
            : detectNotebookFileFormat(safeName) === 'runme-operation-log' ? RUNME_OPERATION_LOG_MIME_TYPE
            : 'application/json',
          parents: [parentUri],
        };
      } catch (error) {
        // Only remove an empty target. A failed writer or another process may
        // have populated the path after our check; deleting it would lose data.
        const failedFile = await fileHandle.getFile().catch(() => undefined)
        if (failedFile?.size === 0) {
          await dirHandle.removeEntry(safeName).catch(() => {})
        }
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
    if (!workspace) return physicalEntryLockId(workspaceId, relativePath)

    const equivalentEntryIds = [physicalEntryLockId(workspaceId, relativePath)]
    for (const candidate of await this.db.workspaces.toArray()) {
      if (candidate.id === workspaceId) continue
      try {
        if (await workspace.rootHandle.isSameEntry(candidate.rootHandle)) {
          equivalentEntryIds.push(
            physicalEntryLockId(candidate.id, relativePath)
          )
          continue
        }

        const candidateBelowWorkspace = await workspace.rootHandle.resolve(
          candidate.rootHandle
        )
        if (candidateBelowWorkspace) {
          const candidatePrefix = candidateBelowWorkspace.join('/')
          if (relativePath === candidatePrefix) {
            equivalentEntryIds.push(physicalEntryLockId(candidate.id, ''))
          } else if (relativePath.startsWith(`${candidatePrefix}/`)) {
            equivalentEntryIds.push(
              physicalEntryLockId(
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
            physicalEntryLockId(
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

    if (safeName === oldName) return (await this.getMetadata(uri))!
    const parentUri = buildFsUri(parsed.workspaceId, parentRelPath, 'directory')
    // Use the same exclusive destination claim as create, including for overlapping mounts.
    const created = await this.createFileWithContent(parentUri, safeName, content, 'createContent')
    const current = await (await dirHandle.getFileHandle(oldName)).getFile()
    if (current.lastModified !== oldFile.lastModified || await current.text() !== content) {
      throw new Error('The source changed during rename. Both files have been preserved.')
    }
    await dirHandle.removeEntry(oldName)

    // Clean up old entry record.
    const oldRecId = entryRecordId(parsed.workspaceId, parsed.relativePath)
    await this.db.entries.delete(oldRecId)
    this.baseRevisions.delete(oldRecId)
    const preservation = this.ipynbState.get(oldRecId)
    this.ipynbState.delete(oldRecId)

    if (preservation) {
      const newPath = parseFsUri(created.uri).relativePath
      this.ipynbState.set(entryRecordId(parsed.workspaceId, newPath), preservation)
    }
    return created
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
    const text = await file.text()
    this.baseRevisions.set(recId, {
      lastModified: file.lastModified,
      size: file.size,
      checksum: md5(text),
    })
    return text
  }

  async saveContent(uri: string, content: string): Promise<void> {
    const parsed = parseFsUri(uri)
    if (parsed.kind !== 'file') {
      throw new Error('FilesystemNotebookStore.saveContent expects a file URI')
    }
    const recId = entryRecordId(parsed.workspaceId, parsed.relativePath)
    const decoded =
      detectNotebookFileFormat(parsed.relativePath) === 'ipynb'
        ? decodeNotebookFile(content, parsed.relativePath)
        : undefined
    const baseRevision = this.baseRevisions.get(recId)
    await this.writeContent(parsed, content, baseRevision)
    if (decoded?.ipynb) {
      this.ipynbState.set(recId, {
        shadowText: decoded.ipynb.shadowText,
        state: decoded.ipynb,
      })
    }
  }

  /** Serialize overlapping mounts at the physical path and recheck the observed version inside the lock. */
  private async writeContent(parsed: ParsedFsUri, content: string, baseRevision?: BaseRevision): Promise<void> {
    const { workspaceId, relativePath } = parsed
    const recId = entryRecordId(workspaceId, relativePath)
    const lockKey = await this.physicalEntryLockKey(workspaceId, relativePath)
    await runFilesystemExclusive(lockKey, async () => {
      const handle = await this.resolveFileHandle(workspaceId, relativePath)
      if (baseRevision) {
        const current = await handle.getFile()
        if (
          current.lastModified !== baseRevision.lastModified ||
          current.size !== baseRevision.size ||
          (baseRevision.checksum !== undefined && md5(await current.text()) !== baseRevision.checksum)
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
        checksum: md5(content),
      })
      await this.db.entries.update(recId, {
        lastKnownMtime: updated.lastModified,
        lastKnownSize: updated.size,
      })
    })
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
    const ws = await this.db.workspaces.get(workspaceId)
    if (ws?.mounted === false) throw new Error('Folder disconnected. Mount it again to resume sync.')
    // A cached handle can follow a file moved outside its mounted path.
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
    // Resolve from the mount each time. A cached child handle can follow a
    // directory that was moved outside the mount, or outlive its permission.
    const ws = await this.db.workspaces.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`)
    if (ws.mounted === false) throw new Error('Folder disconnected. Mount it again to resume sync.')

    if (!relativePath) {
      return ws.rootHandle;
    }

    const segments = relativePath.split("/").filter(Boolean);
    let dirHandle: FileSystemDirectoryHandle = ws.rootHandle;
    for (const segment of segments) {
      dirHandle = await dirHandle.getDirectoryHandle(segment);
    }

    return dirHandle;
  }
}
