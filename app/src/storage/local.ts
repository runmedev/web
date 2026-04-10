import Dexie, { Table } from "dexie";
import { create, toJsonString, fromJsonString } from "@bufbuild/protobuf";
import { v4 as uuidv4 } from "uuid";
import md5 from "md5";
import { Subject, debounceTime } from "rxjs";

import { parser_pb } from "../runme/client";
import { aisreClientManager as runmeClientManager } from "../lib/aisreClientManager";
import { appState } from "../lib/runtime/AppState";
import { appLogger } from "../lib/logging/runtime";
import {
  DriveNotebookStore,
  type DriveVersionMetadata,
  isDriveItemUri,
} from "./drive";
import type { FilesystemNotebookStore } from "./fs";
import {
  NotebookStoreItem,
  NotebookStoreItemType,
} from "./notebook";

// Local folder URI is a special folder that contains all notebooks which are local (i.e. not synced to Drive)
export const LOCAL_FOLDER_URI = "local://folder/local";

const NOTEBOOK_JSON_WRITE_OPTIONS = {
  emitDefaultValues: true,
} as unknown as Parameters<typeof toJsonString>[2];

/**
 * LocalFileRecord captures the information needed to persist a notebook locally.
 *
 * The split between `id` and `remoteId` allows us to keep one stable local
 * identity while tracking the upstream URI that owns the authoritative external
 * resource. Browser-only notebooks use the local URI as their upstream URI.
 */
export interface LocalFileRecord {
  /** Stable local identifier (formatted as local://file/<uuid>). */
  id: string;
  /** Friendly name for the notebook, used when rendering the UI. */
  name: string;
  /** Upstream URI. Browser-only notebooks use the same local://file/... URI. */
  remoteId: string;
  /** Creation-time upstream parent URI used to finish a pending remote create. */
  parentRemoteIdWhenCreated?: string;
  /** Remote Drive URI of the Markdown sidecar (e.g. *.index.md) if present. */
  markdownUri?: string;
  /**
   * Checksum returned by the most recent Drive sync. Empty string means the
   * notebook has never been uploaded or the checksum was unavailable.
   */
  lastRemoteChecksum: string;
  /** ISO timestamp of the last successful sync with Drive (empty if never). */
  lastSynced: string;
  /** Last successfully observed upstream revision/checksum metadata. */
  lastUpstreamVersion?: UpstreamVersion;
  /** Last sync failure, if any. Cleared after successful sync. */
  lastSyncError?: string;
  /**
   * JSON serialized notebook document. Using a string keeps the IndexedDB
   * representation simple and defers parsing to the caller.
   */
  doc: string;
  /**
   * MD5 checksum of `doc`. Persisted so reconciler scans can detect local
   * changes without re-hashing every file on each pass.
   */
  md5Checksum: string;
}

export interface UpstreamVersion {
  checksum?: string;
  revisionId?: string;
  modifiedTime?: string;
  sizeBytes?: number;
}

export type NotebookSyncStatus =
  | "local-only"
  | "synced"
  | "pending"
  | "pending-upstream-create"
  | "syncing"
  | "error";

export interface NotebookSyncState {
  status: NotebookSyncStatus;
  localUri: string;
  remoteId: string;
  parentRemoteIdWhenCreated?: string;
  lastSynced?: string;
  lastUpstreamVersion?: UpstreamVersion;
  lastError?: string;
}

/**
 * LocalFolderRecord represents a folder in the mirrored hierarchy.
 *
 * Children entries always use *local* URIs so the UI can work offline. When a
 * remote Drive folder exists we also track its origin through `remoteId`.
 */
export interface LocalFolderRecord {
  /** Stable local identifier (formatted as local://folder/<uuid>). */
  id: string;
  /** Friendly name for the folder when displayed locally. */
  name: string;
  /** Remote Drive URI if the folder is mirrored, otherwise an empty string. */
  remoteId: string;
  /**
   * Local URIs for the children contained in this folder. The array keeps the
   * ordering stable and allows quick traversal when rendering the notebook tree.
   */
  children: string[];
  /** ISO timestamp of the last successful sync with Drive (empty if never). */
  lastSynced: string;
}

// TODO(jlewi): I believe LocalNotebooks is improperly named at this point.
// I think at this point it is providing a unified interface for both local and
// remote storage systems. I believe at this point all the different parts of the
// app that need to read and write notebooks should be using this class. 
// This class then hides caching the notebooks locally in IndexedDB and syncing them
// to the remote store (e.g. Google Drive).

/**
 * LocalNotebooks provides a thin Dexie wrapper around the two IndexedDB tables
 * we use to mirror Drive content. Higher level services are responsible for the
 * actual sync logic; this class only defines the storage schema and exposes the
 * typed table handles.
 */
export class LocalNotebooks extends Dexie {
  /** IndexedDB table where notebook files are stored. */
  files!: Table<LocalFileRecord, string>;

  /** IndexedDB table where folder metadata is stored. */
  folders!: Table<LocalFolderRecord, string>;

  private readonly driveStore: DriveNotebookStore;
  private filesystemStore: FilesystemNotebookStore | null = null;

  private readonly syncSubjects = new Map<string, Subject<void>>();
  private readonly markdownSyncSubjects = new Map<string, Subject<void>>();
  private readonly inFlightSyncs = new Map<string, Promise<void>>();
  private readonly syncListeners = new Map<string, Set<() => void>>();

  constructor(
    driveStore: DriveNotebookStore,
    databaseName: string = "runme-local-notebooks",
  ) {
    super(databaseName);

    // Define the database schema. Version(1) gives us a clear starting point
    // for future migrations. Both tables are keyed by the `id` property.
    this.version(1).stores({
      files: "&id, remoteId, lastRemoteChecksum, name",
      folders: "&id, remoteId, name",
    });
    this.version(2)
      .stores({
        files: "&id, remoteId, lastRemoteChecksum, name, lastSynced",
        folders: "&id, remoteId, name, lastSynced",
      })
      .upgrade(async (tx) => {
        await tx.table("files").toCollection().modify((file: Partial<LocalFileRecord>) => {
          if (typeof file.lastSynced !== "string") {
            file.lastSynced = "";
          }
        });
        await tx.table("folders").toCollection().modify((folder: Partial<LocalFolderRecord>) => {
          if (typeof folder.lastSynced !== "string") {
            folder.lastSynced = "";
          }
        });
      });
    this.version(3)
      .stores({
        files: "&id, remoteId, lastRemoteChecksum, md5Checksum, name, lastSynced",
        folders: "&id, remoteId, name, lastSynced",
      })
      .upgrade(async (tx) => {
        await tx.table("files").toCollection().modify((file: Partial<LocalFileRecord>) => {
          if (typeof file.md5Checksum !== "string") {
            // Lazy backfill: keep migration cheap and compute missing checksums
            // when we evaluate whether a file needs syncing.
            file.md5Checksum = "";
          }
        });
      });
    this.version(4)
      .stores({
        files: "&id, remoteId, lastRemoteChecksum, md5Checksum, name, lastSynced",
        folders: "&id, remoteId, name, lastSynced",
      })
      .upgrade(async (tx) => {
        await tx.table("files").toCollection().modify((file: Partial<LocalFileRecord>) => {
          if (typeof file.remoteId !== "string" || file.remoteId === "") {
            file.remoteId = file.id ?? "";
          }
        });
      });
    this.version(5)
      .stores({
        files: "&id, remoteId, lastRemoteChecksum, md5Checksum, name, lastSynced",
        folders: "&id, remoteId, name, lastSynced",
      })
      .upgrade(async (tx) => {
        await tx.table("files").toCollection().modify((file: Partial<LocalFileRecord>) => {
          delete file.lastUpstreamVersion;
          delete file.lastSyncError;
          delete file.parentRemoteIdWhenCreated;
        });
      });

    // Bind the table helpers so callers can access them directly.
    this.files = this.table("files");
    this.folders = this.table("folders");

    this.driveStore = driveStore;

    void this.ensureFolderRecord(
      LOCAL_FOLDER_URI,
      "Local Notebooks",
    );
  }

  setFilesystemStore(store: FilesystemNotebookStore | null): void {
    this.filesystemStore = store;
  }

  /**
   * Ensure that the given remote file has a local representation and return its
   * local URI. If the file has already been mirrored we simply hand back the
   * existing identifier.
   */
  async addFile(remoteUri: string, name?: string): Promise<string> {
    if (!remoteUri) {
      throw new Error("addFile requires a non-empty remote URI");
    }

    const existing = await this.files
      .where("remoteId")
      .equals(remoteUri)
      .first();
    if (existing) {
      if (name && name !== existing.name) {
        await this.files.update(existing.id, { name });
      }
      return existing.id;
    }

    const id = this.generateLocalUri("file");
    const resolvedName =
      name ??
      this.deriveDisplayNameFromUri(remoteUri) ??
      "Untitled Notebook";

    const record: LocalFileRecord = {
      id,
      name: resolvedName,
      remoteId: remoteUri,
      lastRemoteChecksum: "",
      lastSynced: "",
      doc: "",
      md5Checksum: "",
    };

    await this.files.put(record);
    return id;
  }

  /**
   * Ensure that a loaded notebook from an upstream file has a local editable
   * mirror and return the local URI for editor/tab state.
   */
  async addNotebook(
    upstreamUri: string,
    name: string,
    notebook: parser_pb.Notebook,
  ): Promise<string> {
    if (!upstreamUri) {
      throw new Error("addNotebook requires a non-empty upstream URI");
    }

    const serialized = serializeNotebook(notebook);
    const checksum = checksumForSerializedNotebook(serialized);
    const existing = await this.files
      .where("remoteId")
      .equals(upstreamUri)
      .first();

    if (existing) {
      const existingChecksum = await this.getOrBackfillLocalChecksum(
        existing.id,
        existing,
      );
      const existingBaseline = existing.lastRemoteChecksum ?? "";
      const hasLocalChanges =
        existing.doc !== "" && existingChecksum !== existingBaseline;
      if (hasLocalChanges) {
        appLogger.warn("Preserving local mirror while opening changed upstream notebook", {
          attrs: {
            scope: "storage.local.mirror",
            localUri: existing.id,
            upstreamUri,
            localChecksum: existingChecksum,
            upstreamChecksum: checksum,
            lastRemoteChecksum: existingBaseline,
          },
        });
        await this.files.update(existing.id, { name });
      } else {
        await this.files.update(existing.id, {
          name,
          doc: serialized,
          md5Checksum: checksum,
          lastRemoteChecksum: checksum,
          lastUpstreamVersion: { checksum },
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
        });
      }
      return existing.id;
    }

    const id = this.generateLocalUri("file");
    const record: LocalFileRecord = {
      id,
      name,
      remoteId: upstreamUri,
      lastRemoteChecksum: checksum,
      lastUpstreamVersion: { checksum },
      lastSynced: nowIsoString(),
      doc: serialized,
      md5Checksum: checksum,
    };

    await this.files.put(record);
    return id;
  }

  /**
   * Mirror the contents of a remote folder into IndexedDB. Every Drive file
   * discovered is guaranteed to have a local entry afterwards and the folder's
   * `children` array is updated to reflect the latest local URIs.
   */
  async updateFolder(remoteUri: string, name?: string): Promise<string> {
    if (!remoteUri) {
      throw new Error("updateFolder requires a non-empty remote URI");
    }

    const existingFolder = await this.folders
      .where("remoteId")
      .equals(remoteUri)
      .first();

    const folderId =
      existingFolder?.id ?? this.generateLocalUri("folder");
    const fallbackName =
      this.deriveDisplayNameFromUri(remoteUri) ?? "Untitled Folder";
    let resolvedName =
      name ?? existingFolder?.name ?? fallbackName;

    // When callers don't provide a name, resolve the remote folder metadata so
    // new mounts use the human-readable Drive name instead of an id-derived
    // fallback. If an existing record still has that fallback name, upgrade it.
    if (!name && (!existingFolder || existingFolder.name === fallbackName)) {
      try {
        const metadata = await this.driveStore.getMetadata(remoteUri);
        const remoteName = metadata?.name?.trim();
        if (remoteName) {
          resolvedName = remoteName;
        }
      } catch (error) {
        console.error(
          "Failed to resolve Drive folder name from metadata",
          remoteUri,
          error,
        );
      }
    }

    // Ensure the folder exists locally before we populate it.
    if (!existingFolder) {
      const initialRecord: LocalFolderRecord = {
        id: folderId,
        name: resolvedName,
        remoteId: remoteUri,
        children: [],
        lastSynced: "",
      };
      await this.folders.put(initialRecord);
    } else if (existingFolder.name !== resolvedName) {
      await this.folders.update(folderId, { name: resolvedName });
    }

    // Fetch the latest Drive listing and mirror any notebooks we discover.
    const items = await this.driveStore.list(remoteUri);
    const childUris: string[] = [];

    for (const item of items) {
      if (item.type === NotebookStoreItemType.File) {
        const localUri = await this.addFile(item.uri, item.name);
        childUris.push(localUri);
      } else if (item.type === NotebookStoreItemType.Folder) {
        const localFolderUri = await this.updateFolder(item.uri, item.name);
        childUris.push(localFolderUri);
      }
    }

    const existingChildren = existingFolder?.children ?? [];
    for (const childUri of existingChildren) {
      const childRecord = childUri.startsWith("local://file/")
        ? await this.files.get(childUri)
        : null;
      if (
        childRecord?.remoteId === "" &&
        childRecord.parentRemoteIdWhenCreated === remoteUri &&
        !childUris.includes(childUri)
      ) {
        childUris.push(childUri);
      }
    }

    await this.folders.update(folderId, {
      name: resolvedName,
      children: childUris,
    });

    return folderId;
  }

  async sync(localUri: string): Promise<void> {
    if (localUri.startsWith("local://file/")) {
      await this.syncFile(localUri);
      return;
    }

    if (localUri.startsWith("local://folder/")) {
      await this.syncFolder(localUri);
      return;
    }

    throw new Error(`Unsupported local URI format: ${localUri}`);
  }

  subscribeSync(localUri: string, listener: () => void): () => void {
    let listeners = this.syncListeners.get(localUri);
    if (!listeners) {
      listeners = new Set();
      this.syncListeners.set(localUri, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.syncListeners.get(localUri);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.syncListeners.delete(localUri);
      }
    };
  }

  async getSyncState(localUri: string): Promise<NotebookSyncState> {
    const record = await this.files.get(localUri);
    if (!record) {
      return {
        status: "error",
        localUri,
        remoteId: "",
        lastError: `Local notebook record not found for ${localUri}`,
      };
    }

    if (this.inFlightSyncs.has(localUri)) {
      return syncStateForRecord(record, "syncing");
    }

    if (record.remoteId === "" && record.parentRemoteIdWhenCreated) {
      return syncStateForRecord(
        record,
        record.lastSyncError ? "error" : "pending-upstream-create",
      );
    }

    if (record.remoteId === "") {
      return syncStateForRecord(record, "error", "Missing upstream URI");
    }

    if (isLocalFileUpstream(record.remoteId, record.id)) {
      return syncStateForRecord(record, "local-only");
    }

    if (record.lastSyncError) {
      return syncStateForRecord(record, "error");
    }

    const localChecksum = await this.getOrBackfillLocalChecksum(localUri, record);
    const upstreamChecksum = record.lastRemoteChecksum ?? "";
    return syncStateForRecord(
      { ...record, md5Checksum: localChecksum },
      localChecksum === upstreamChecksum ? "synced" : "pending",
    );
  }

  async getMetadata(uri: string): Promise<NotebookStoreItem | null> {
    if (!uri.startsWith("local://")) {
      throw new Error("getMetadata expects a local:// URI");
    }

    if (uri === LOCAL_FOLDER_URI) {
      const files = await this.files
        .filter((file) => isLocalFileUpstream(file.remoteId, file.id))
        .toArray();
      return {
        uri,
        name: "Local Notebooks",
        type: NotebookStoreItemType.Folder,
        children: files.map((file) => file.id),
        remoteUri: undefined,
        parents: [],
      };
    }

    if (uri.startsWith("local://file/")) {
      const record = await this.files.get(uri);
      if (!record) {
        return null;
      }
      const parentFolder = await this.findParentFolder(record.id);
      return {
        uri: record.id,
        name: record.name,
        type: NotebookStoreItemType.File,
        children: [],
        remoteUri: publicRemoteUri(record),
        parents: parentFolder ? [parentFolder.id] : [],
      };
    }

    if (uri.startsWith("local://folder/")) {
      const record = await this.folders.get(uri);
      if (!record) {
        return null;
      }
      const parentFolder = await this.findParentFolder(record.id);
      return {
        uri: record.id,
        name: record.name,
        type: NotebookStoreItemType.Folder,
        children: [...record.children],
        remoteUri: publicRemoteUri(record),
        parents: parentFolder ? [parentFolder.id] : [],
      };
    }

    throw new Error(`Unsupported local URI format: ${uri}`);
  }

  /**
   * Persist a notebook into the local store. The caller provides a local URI
   * (e.g. `local://file/<uuid>`) that acts as the primary key for the record.
   */
  async save(
    uri: string,
    notebook: parser_pb.Notebook,
  ): Promise<void> {
    if (!uri.startsWith("local://file/")) {
      throw new Error("LocalNotebooks.save expects a local://file/ URI; got " + uri);
    }

    await this.persistNotebook(uri, notebook);
    this.enqueueSync(uri);
    this.enqueueMarkdownSync(uri);
  }

  private async persistNotebook(
    uri: string,
    notebook: parser_pb.Notebook,
  ): Promise<void> {
    const record = await this.files.get(uri);
    if (!record) {
      throw new Error(
        `Local notebook record not found for ${uri}. Call addFile first.`,
      );
    }

    const serialized = serializeNotebook(notebook);
    const checksum = checksumForSerializedNotebook(serialized);

    await this.files.update(uri, { doc: serialized, md5Checksum: checksum });
    this.notifySync(uri);
  }

  async load(uri: string): Promise<parser_pb.Notebook> {
    if (!uri.startsWith("local://file/")) {
      throw new Error("LocalNotebooks.load expects a local://file/ URI; got " + uri);
    }

    const existing = await this.files.get(uri);
    if (!existing) {
      throw new Error(`Local notebook record not found for ${uri}; call addFile first.`);
    }

    const shouldSync = needsSync(existing.lastSynced, 8 * 60 * 60 * 1000);

    let record = existing;
    if (shouldSync) {
      // Best-effort attempt to ensure the local cache reflects the latest remote state
      // before we hydrate the notebook for the caller.
      try {
        await this.syncFile(uri);
      } catch (error) {
        appLogger.warn("Continuing with local notebook after sync-on-load failed", {
          attrs: {
            scope: "storage.local.sync",
            localUri: uri,
            error: String(error),
          },
        });
      }

      const refreshed = await this.files.get(uri);
      if (!refreshed) {
        throw new Error(`Local notebook record missing for ${uri} after sync.`);
      }
      record = refreshed;
    }

    if (!record.doc) {
      return create(parser_pb.NotebookSchema, { cells: [] });
    }

    try {
      return fromJsonString(parser_pb.NotebookSchema, record.doc, {
        ignoreUnknownFields: true,
      });
    } catch (error) {
      console.error("Failed to parse notebook from local store", error);
      return create(parser_pb.NotebookSchema, { cells: [] });
    }
  }

  async create(parentUri: string, name: string): Promise<NotebookStoreItem> {
    if (!parentUri.startsWith("local://folder/")) {
      throw new Error("LocalNotebooks.create expects a folder parent URI");
    }

    const parent = await this.folders.get(parentUri);
    if (!parent) {
      throw new Error(`Parent folder not found for ${parentUri}`);
    }

    const fileUri = this.generateLocalUri("file");
    const isDriveBackedParent = isDriveUri(parent.remoteId);
    const record: LocalFileRecord = {
      id: fileUri,
      name,
      remoteId: isDriveBackedParent ? "" : fileUri,
      parentRemoteIdWhenCreated: isDriveBackedParent ? parent.remoteId : undefined,
      lastRemoteChecksum: "",
      lastSynced: isDriveBackedParent ? "" : nowIsoString(),
      doc: "",
      md5Checksum: "",
    };
    await this.files.put(record);

    await this.folders.update(parentUri, {
      children: [...parent.children, fileUri],
      lastSynced: nowIsoString(),
    });

    if (canDispatchWindowEvents()) {
      window.dispatchEvent(
        new CustomEvent("local-notebook-updated", {
          detail: { uri: fileUri, name, remoteUri: undefined },
        }),
      );
    }

    if (isDriveBackedParent) {
      void (async () => {
        try {
          await this.syncFile(fileUri);
        } catch (error) {
          appLogger.warn("Pending Drive notebook creation did not complete", {
            attrs: {
              scope: "storage.drive.sync",
              localUri: fileUri,
              parentRemoteUri: parent.remoteId,
              error: String(error),
            },
          });
        }
      })();
    }

    return {
      uri: fileUri,
      name,
      type: NotebookStoreItemType.File,
      children: [],
      remoteUri: undefined,
      parents: [parentUri],
    };
  }

  async rename(uri: string, name: string): Promise<NotebookStoreItem> {
    if (!uri.startsWith("local://file/")) {
      throw new Error("LocalNotebooks.rename expects a file URI");
    }

    const record = await this.files.get(uri);
    if (!record) {
      throw new Error(`Local notebook record not found for ${uri}`);
    }

    await this.files.update(uri, { name });

    const parentFolder = await this.findParentFolder(uri);

    if (canDispatchWindowEvents()) {
      window.dispatchEvent(
        new CustomEvent("local-notebook-updated", {
          detail: { uri, name, remoteUri: publicRemoteUri(record) },
        }),
      );
    }

    void (async () => {
      if (!isDriveUri(record.remoteId)) {
        return;
      }
      try {
        await this.driveStore.rename(record.remoteId, name);
      } catch (error) {
        console.error("Failed to rename remote Drive notebook", error);
      }
    })();

    return {
      uri,
      name,
      type: NotebookStoreItemType.File,
      children: [],
      remoteUri: publicRemoteUri(record),
      parents: parentFolder ? [parentFolder.id] : [],
    };
  }

  /**
   * Ensure a Markdown sidecar file exists and is synced to Drive for the given file.
   * The purpose of the sidecar file is to make the content available to company knowledge for
   * indexing to make it available to ChatGPT.
   * This is a best-effort helper and does nothing for files that are not backed
   * by Google Drive.
   */
  async syncMarkdownFile(localUri: string): Promise<void> {
    if (!localUri.startsWith("local://file/")) {
      throw new Error("syncMarkdownFile expects a local://file/ URI");
    }

    const record = await this.files.get(localUri);
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`);
    }

    // Only Drive-backed files need a Markdown sidecar.
    if (!isDriveUri(record.remoteId)) {
      return;
    }

    const driveStore = appState.driveNotebookStore ?? this.driveStore;
    if (!driveStore) {
      console.error("No DriveNotebookStore available for syncing markdown");
      return;
    }

    let markdownUri = record.markdownUri;

    if (!markdownUri) {
      const metadata = await driveStore.getMetadata(record.remoteId);
      const parentUri = metadata?.parents?.[0];
      const name = metadata?.name ?? "notebook";

      if (!parentUri) {
        console.warn("Cannot create markdown sidecar without parent folder", {
          remoteId: record.remoteId,
        });
        return;
      }

      const baseName = name.replace(/\.[^.]+$/, "");
      const markdownName = `${baseName}.index.md`;

      const markdownFile = await driveStore.create(parentUri, markdownName);
      markdownUri = markdownFile.uri;
      await this.files.update(localUri, { markdownUri });
    }

    // Serialize the notebook to Markdown via the parser service.
    let markdownBytes: Uint8Array;
    try {
      const notebook = deserializeNotebook(record.doc ?? "");
      const client = runmeClientManager.get();
      markdownBytes = await client.serializeNotebook(
        notebook,
        create(parser_pb.SerializeRequestOptionsSchema, {
          outputs: create(parser_pb.SerializeRequestOutputOptionsSchema, {
            enabled: true,
            // Summary controls information about execution. I don't think we need that.
            summary: false,
          }),
        }),
      );
    } catch (error) {
      console.error("Failed to serialize notebook to markdown", error);
      return;
    }

    const markdownContent = new TextDecoder().decode(markdownBytes);

    try {
      await driveStore.saveContent(markdownUri, markdownContent, "text/markdown");
    } catch (error) {
      console.error("Failed to upload markdown sidecar to Drive", error);
    }
  }

  /**
   * Generate a stable local URI for a file or folder using a random UUID.
   */
  private generateLocalUri(type: "file" | "folder"): string {
    const uuid = uuidv4();
    return `local://${type}/${uuid}`;
  }

  /**
   * Return local URIs for Drive-backed files that currently have unapplied
   * local changes relative to the last known remote checksum.
   *
   * For migrated records where `md5Checksum` is missing/empty but `doc` exists,
   * this method computes and persists the checksum lazily.
   */
  async listDriveBackedFilesNeedingSync(): Promise<string[]> {
    const driveBackedFiles = await this.files
      .filter((record) =>
        isDriveUri(record.remoteId) ||
        Boolean(record.parentRemoteIdWhenCreated),
      )
      .toArray();
    const pending: string[] = [];

    for (const record of driveBackedFiles) {
      if (record.remoteId === "" && record.parentRemoteIdWhenCreated) {
        pending.push(record.id);
        continue;
      }
      const localChecksum = await this.getOrBackfillLocalChecksum(record.id, record);
      const lastRemoteChecksum = record.lastRemoteChecksum ?? "";
      if (localChecksum !== lastRemoteChecksum) {
        pending.push(record.id);
      }
    }

    return pending;
  }

  /**
   * Enqueue sync for every Drive-backed file that appears locally modified.
   * Returns the list of enqueued local URIs.
   */
  async enqueueDriveBackedFilesNeedingSync(): Promise<string[]> {
    const pending = await this.listDriveBackedFilesNeedingSync();
    appLogger.info("Drive resync reconciliation evaluated pending files", {
      attrs: {
        scope: "storage.drive.sync",
        code: "DRIVE_RESYNC_EVALUATED",
        pendingCount: pending.length,
        localUris: pending,
      },
    });
    for (const uri of pending) {
      appLogger.info("Requeued Drive-backed notebook for sync", {
        attrs: {
          scope: "storage.drive.sync",
          code: "DRIVE_RESYNC_REQUEUED_FILE",
          localUri: uri,
        },
      });
      this.enqueueSync(uri);
      this.enqueueMarkdownSync(uri);
    }
    return pending;
  }

  private enqueueSync(uri: string): void {
    let subject = this.syncSubjects.get(uri);
    if (!subject) {
      subject = new Subject<void>();
      const DEBOUNCE_TIME_MS = 20 * 1000; // 20 seconds
      subject.pipe(debounceTime(DEBOUNCE_TIME_MS)).subscribe(async () => {
        try {
          await this.syncFile(uri);
        } catch (error) {
          console.error("Failed to synchronise notebook", uri, error);
        }
      });
      this.syncSubjects.set(uri, subject);
    }
    subject.next();
  }

  private notifySync(uri: string): void {
    const listeners = this.syncListeners.get(uri);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          console.error("Local notebook sync listener failed", error);
        }
      }
    }
    if (canDispatchWindowEvents()) {
      window.dispatchEvent(
        new CustomEvent("local-notebook-sync-updated", {
          detail: { uri },
        }),
      );
    }
  }

  private enqueueMarkdownSync(uri: string): void {
    let mdSubject = this.markdownSyncSubjects.get(uri);
    if (!mdSubject) {
      mdSubject = new Subject<void>();
      const DEBOUNCE_TIME_MS = 20 * 1000; // 20 seconds
      mdSubject.pipe(debounceTime(DEBOUNCE_TIME_MS)).subscribe(async () => {
        try {
          await this.syncMarkdownFile(uri);
        } catch (error) {
          console.error("Failed to synchronise markdown sidecar", uri, error);
        }
      });
      this.markdownSyncSubjects.set(uri, mdSubject);
    }
    mdSubject.next();
  }

  private async getOrBackfillLocalChecksum(
    localUri: string,
    record: LocalFileRecord,
  ): Promise<string> {
    const doc = record.doc ?? "";
    if (typeof record.md5Checksum === "string") {
      // Empty docs intentionally hash to "" and do not need backfill writes.
      if (record.md5Checksum !== "" || doc === "") {
        return record.md5Checksum;
      }
    }

    const checksum = checksumForSerializedNotebook(doc);
    await this.files.update(localUri, { md5Checksum: checksum });
    return checksum;
  }

  private async ensureFolderRecord(
    id: string,
    name: string,
  ): Promise<LocalFolderRecord> {
    const existing = await this.folders.get(id);
    if (existing) {
      return existing;
    }
    const record: LocalFolderRecord = {
      id,
      name,
      remoteId: id,
      children: [],
      lastSynced: "",
    };
    await this.folders.put(record);
    return record;
  }

  /**
   * Derive a fallback display name from the tail of a remote URI. This is a
   * best-effort helper and may return null if no meaningful segment exists.
   */
  private deriveDisplayNameFromUri(uri: string): string | null {
    try {
      const url = new URL(uri);
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length > 0) {
        return decodeURIComponent(segments[segments.length - 1]);
      }
    } catch {
      // Ignore parse failures and fall bacfk to the simple heuristic below.
    }

    const rawSegments = uri.split("/").filter(Boolean);
    if (rawSegments.length > 0) {
      return rawSegments[rawSegments.length - 1];
    }

    return null;
  }

  private async syncFile(localUri: string): Promise<void> {
    const existingSync = this.inFlightSyncs.get(localUri);
    if (existingSync) {
      return existingSync;
    }

    const operation = Promise.resolve().then(async () => {
      try {
        await this.syncFileInner(localUri);
        await this.files.update(localUri, { lastSyncError: undefined });
      } catch (error) {
        await this.files.update(localUri, { lastSyncError: String(error) });
        throw error;
      }
    });
    this.inFlightSyncs.set(localUri, operation);
    this.notifySync(localUri);

    const cleanup = () => {
      if (this.inFlightSyncs.get(localUri) !== operation) {
        return;
      }
      this.inFlightSyncs.delete(localUri);
      this.notifySync(localUri);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private async syncFileInner(localUri: string): Promise<void> {
    let record = await this.files.get(localUri);
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`);
    }

    // Files that do not have a remote counterpart live exclusively in
    // IndexedDB. There is nothing to synchronise for those entries, so we can
    // exit early once we've confirmed the local metadata exists.
    let completedPendingCreate = false;
    if (!record.remoteId) {
      if (!record.parentRemoteIdWhenCreated) {
        throw new Error(
          `Local notebook ${localUri} is missing remoteId and pending parent`,
        );
      }
      await this.completePendingDriveCreate(localUri, record);
      completedPendingCreate = true;
      const updated = await this.files.get(localUri);
      if (!updated?.remoteId) {
        throw new Error(`Failed to create Drive file for pending notebook ${localUri}`);
      }
      record = updated;
    }

    if (isLocalFileUpstream(record.remoteId, localUri)) {
      await this.files.update(localUri, {
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
      });
      return;
    }

    if (isFilesystemUri(record.remoteId)) {
      await this.syncSerializedNotebookUpstream(localUri, record);
      return;
    }

    if (!isDriveUri(record.remoteId)) {
      throw new Error(
        `Unsupported upstream URI ${record.remoteId} for local notebook ${localUri}`,
      );
    }

    const remoteUri = record.remoteId;

    let remoteName: string | undefined;
    try {
      const metadata = await this.driveStore.getMetadata(remoteUri);
      remoteName = metadata?.name;
    } catch (error) {
      console.error("Failed to fetch remote metadata for", remoteUri, error);
    }
    if (remoteName && remoteName !== record.name) {
      await this.files.update(localUri, { name: remoteName });
    }

    // Fetch the current checksum from Drive. We treat "missing" as an empty
    // string so downstream comparisons remain simple string equality checks.
    let currentVersion: UpstreamVersion = {};
    let currentRemoteChecksum = "";
    try {
      currentVersion = driveMetadataToUpstreamVersion(
        await this.driveStore.getVersionMetadata(remoteUri),
      );
      currentRemoteChecksum = currentVersion.checksum ?? "";
    } catch (error) {
      console.error(
        "Failed to retrieve remote checksum while synchronising",
        remoteUri,
        error,
      );
      throw error;
    }

    const lastReadChecksum = record.lastRemoteChecksum ?? "";
    const localDoc = record.doc ?? "";
    const localChecksum = await this.getOrBackfillLocalChecksum(localUri, record);
    let synced = false;

    // Case 1: The checksum reported by Drive matches the version we last
    // observed. This means no external party has modified the remote file and
    // the local content is authoritative. We can safely push our data back to
    // Drive without risking data loss.
    if (currentRemoteChecksum === lastReadChecksum) {
      await this.saveLocalDocToDrive(localUri, remoteUri, localDoc);
      const updatedVersion = driveMetadataToUpstreamVersion(
        await this.driveStore.getVersionMetadata(remoteUri),
      );
      const updatedChecksum = updatedVersion.checksum ?? "";
      await this.files.update(localUri, {
        lastRemoteChecksum: updatedChecksum,
        lastUpstreamVersion: updatedVersion,
        md5Checksum: localChecksum,
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
      });
      synced = true;
      return;
    }

    // Case 2: We have never read the remote file (the cache holds an empty
    // checksum) but Drive reports a concrete checksum. Download the remote
    // copy only if the local record has no user-authored content. Otherwise,
    // prefer the local IndexedDB content because overwriting it risks data loss.
    if (!lastReadChecksum && currentRemoteChecksum) {
      if (completedPendingCreate && serializedNotebookHasUserContent(localDoc)) {
        await this.saveLocalDocToDrive(localUri, remoteUri, localDoc);
        const updatedVersion = driveMetadataToUpstreamVersion(
          await this.driveStore.getVersionMetadata(remoteUri),
        );
        const updatedChecksum = updatedVersion.checksum ?? "";
        await this.files.update(localUri, {
          lastRemoteChecksum: updatedChecksum,
          lastUpstreamVersion: updatedVersion,
          md5Checksum: localChecksum,
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
        });
        synced = true;
        return;
      }

      if (serializedNotebookHasUserContent(localDoc)) {
        appLogger.warn(
          "Forking local notebook because Drive exists without a baseline checksum",
          {
            attrs: {
              scope: "storage.drive.sync",
              localUri,
              remoteUri,
              remoteChecksum: currentRemoteChecksum,
              localChecksum,
            },
          },
        );
        await this.handleConflict(localUri, record, currentRemoteChecksum);
        synced = true;
        return;
      }

      const remoteNotebook = await this.driveStore.load(remoteUri);
      const serialized = serializeNotebook(remoteNotebook);
      logRemoteOverwriteLocalDoc({
        localUri,
        remoteUri,
        localChecksum,
        remoteChecksum: currentRemoteChecksum,
        reason: "no-local-baseline-checksum",
        localDoc,
        remoteDoc: serialized,
        previousUpstreamRevisionId: record.lastUpstreamVersion?.revisionId,
        upstreamRevisionId: currentVersion.revisionId,
      });
      await this.files.update(localUri, {
        doc: serialized,
        md5Checksum: checksumForSerializedNotebook(serialized),
        lastRemoteChecksum: currentRemoteChecksum,
        lastUpstreamVersion: currentVersion,
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
      });
      synced = true;
      return;
    }

    // Case 3: Drive reports a different checksum than the one we last synced
    // against. If our local content still matches the old checksum, someone
    // else updated the remote file and we simply need to refresh our cache.
    if (currentRemoteChecksum && currentRemoteChecksum !== lastReadChecksum) {
      if (localChecksum === lastReadChecksum) {
        const remoteNotebook = await this.driveStore.load(remoteUri);
        const serialized = serializeNotebook(remoteNotebook);
        logRemoteOverwriteLocalDoc({
          localUri,
          remoteUri,
          localChecksum,
          remoteChecksum: currentRemoteChecksum,
          reason: "local-matches-previous-remote-baseline",
          localDoc,
          remoteDoc: serialized,
          previousUpstreamRevisionId: record.lastUpstreamVersion?.revisionId,
          upstreamRevisionId: currentVersion.revisionId,
        });
        await this.files.update(localUri, {
          doc: serialized,
          md5Checksum: checksumForSerializedNotebook(serialized),
          lastRemoteChecksum: currentRemoteChecksum,
          lastUpstreamVersion: currentVersion,
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
        });
        synced = true;
        return;
      }

      // The remote file changed AND we have unapplied local changes (the local
      // checksum diverges from the shared base). Defer conflict resolution to
      // `handleConflict`, which will fork a new Drive file so data is not lost.
      await this.handleConflict(localUri, record, currentRemoteChecksum);
      synced = true;
      return;
    }

    // Case 4: The remote file does not have a checksum (e.g. an empty file).
    // If we have local content we attempt to seed Drive with it; otherwise we
    // keep the baseline empty.
    if (!currentRemoteChecksum) {
      if (localDoc) {
        await this.saveLocalDocToDrive(localUri, remoteUri, localDoc);
        const updatedVersion = driveMetadataToUpstreamVersion(
          await this.driveStore.getVersionMetadata(remoteUri),
        );
        const updatedChecksum = updatedVersion.checksum ?? "";
        await this.files.update(localUri, {
          lastRemoteChecksum: updatedChecksum,
          lastUpstreamVersion: updatedVersion,
          md5Checksum: localChecksum,
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
        });
        synced = true;
      } else if (lastReadChecksum) {
        await this.files.update(localUri, {
          lastRemoteChecksum: "",
          lastUpstreamVersion: currentVersion,
          md5Checksum: localChecksum,
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
        });
        synced = true;
      }
    }

    if (!synced) {
      await this.files.update(localUri, {
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
      });
    }
  }

  private async saveLocalDocToDrive(
    localUri: string,
    remoteUri: string,
    localDoc: string,
  ): Promise<void> {
    if (!localDoc) {
      await this.driveStore.save(
        remoteUri,
        create(parser_pb.NotebookSchema, { cells: [] }),
      );
      return;
    }

    const parseResult = parseSerializedNotebook(localDoc);
    if (parseResult.ok) {
      await this.driveStore.save(remoteUri, parseResult.notebook);
      return;
    }

    appLogger.warn("Saving raw local notebook JSON because parsing failed", {
      attrs: {
        scope: "storage.drive.sync",
        localUri,
        remoteUri,
        error: String(parseResult.error),
      },
    });
    await this.driveStore.saveContent(remoteUri, localDoc, "application/json");
  }

  private async completePendingDriveCreate(
    localUri: string,
    record: LocalFileRecord,
  ): Promise<void> {
    const parentRemoteUri = record.parentRemoteIdWhenCreated;
    if (!parentRemoteUri) {
      throw new Error(`Missing pending Drive parent for ${localUri}`);
    }
    if (!isDriveUri(parentRemoteUri)) {
      throw new Error(
        `Pending upstream parent is not a Drive folder for ${localUri}: ${parentRemoteUri}`,
      );
    }

    const newFile = await this.driveStore.create(parentRemoteUri, record.name);
    let version: UpstreamVersion = {};
    try {
      version = driveMetadataToUpstreamVersion(
        await this.driveStore.getVersionMetadata(newFile.uri),
      );
    } catch (error) {
      appLogger.warn("Failed to record version metadata for new Drive notebook", {
        attrs: {
          scope: "storage.drive.sync",
          localUri,
          remoteUri: newFile.uri,
          error: String(error),
        },
      });
    }
    const currentRecord = await this.files.get(localUri);
    const localDoc = currentRecord?.doc ?? record.doc ?? "";
    const hasLocalContent = serializedNotebookHasUserContent(localDoc);

    await this.files.update(localUri, {
      name: newFile.name ?? record.name,
      remoteId: newFile.uri,
      parentRemoteIdWhenCreated: undefined,
      lastRemoteChecksum: version.checksum ?? "",
      lastUpstreamVersion: version,
      lastSynced: hasLocalContent ? "" : nowIsoString(),
      lastSyncError: undefined,
    });

    appLogger.info("Created pending Drive notebook upstream file", {
      attrs: {
        scope: "storage.drive.sync",
        localUri,
        parentRemoteUri,
        remoteUri: newFile.uri,
        upstreamChecksum: version.checksum,
        upstreamRevisionId: version.revisionId,
      },
    });

    if (canDispatchWindowEvents()) {
      window.dispatchEvent(
        new CustomEvent("local-notebook-updated", {
          detail: {
            uri: localUri,
            name: newFile.name ?? record.name,
            remoteUri: newFile.uri,
          },
        }),
      );
    }
  }

  private resolveSerializedNotebookStore(upstreamUri: string): {
    load(uri: string): Promise<parser_pb.Notebook>;
    save(uri: string, notebook: parser_pb.Notebook): Promise<unknown>;
  } | null {
    if (isFilesystemUri(upstreamUri)) {
      return this.filesystemStore;
    }
    return null;
  }

  private async syncSerializedNotebookUpstream(
    localUri: string,
    record: LocalFileRecord,
  ): Promise<void> {
    const upstreamUri = record.remoteId;
    const upstreamStore = this.resolveSerializedNotebookStore(upstreamUri);
    if (!upstreamStore) {
      appLogger.warn("Skipping notebook sync because upstream store is unavailable", {
        attrs: {
          scope: "storage.local.sync",
          localUri,
          upstreamUri,
        },
      });
      return;
    }

    const localDoc = record.doc ?? "";
    const localChecksum = await this.getOrBackfillLocalChecksum(localUri, record);
    const lastRemoteChecksum = record.lastRemoteChecksum ?? "";

    if (!localDoc) {
      const upstreamNotebook = await upstreamStore.load(upstreamUri);
      const upstreamDoc = serializeNotebook(upstreamNotebook);
      await this.files.update(localUri, {
        doc: upstreamDoc,
        md5Checksum: checksumForSerializedNotebook(upstreamDoc),
        lastRemoteChecksum: checksumForSerializedNotebook(upstreamDoc),
        lastUpstreamVersion: {
          checksum: checksumForSerializedNotebook(upstreamDoc),
        },
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
      });
      return;
    }

    const upstreamNotebook = await upstreamStore.load(upstreamUri);
    const upstreamDoc = serializeNotebook(upstreamNotebook);
    const upstreamChecksum = checksumForSerializedNotebook(upstreamDoc);

    if (upstreamChecksum !== lastRemoteChecksum) {
      if (localChecksum === lastRemoteChecksum) {
        logRemoteOverwriteLocalDoc({
          localUri,
          remoteUri: upstreamUri,
          localChecksum,
          remoteChecksum: upstreamChecksum,
          reason: "local-matches-previous-upstream-baseline",
          localDoc,
          remoteDoc: upstreamDoc,
        });
        await this.files.update(localUri, {
          doc: upstreamDoc,
          md5Checksum: upstreamChecksum,
          lastRemoteChecksum: upstreamChecksum,
          lastUpstreamVersion: {
            checksum: upstreamChecksum,
          },
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
        });
        return;
      }

      appLogger.warn("Refusing to overwrite changed local and upstream notebooks", {
        attrs: {
          scope: "storage.local.sync",
          localUri,
          upstreamUri,
          localChecksum,
          upstreamChecksum,
          lastRemoteChecksum,
        },
      });
      return;
    }

    const parseResult = parseSerializedNotebook(localDoc);
    if (!parseResult.ok) {
      appLogger.warn("Refusing to sync unparsable local notebook to upstream", {
        attrs: {
          scope: "storage.local.sync",
          localUri,
          upstreamUri,
          error: String(parseResult.error),
        },
      });
      return;
    }

    await upstreamStore.save(upstreamUri, parseResult.notebook);
    await this.files.update(localUri, {
      lastRemoteChecksum: localChecksum,
      lastUpstreamVersion: {
        checksum: localChecksum,
      },
      md5Checksum: localChecksum,
      lastSynced: nowIsoString(),
      lastSyncError: undefined,
    });
  }

  private async handleConflict(
    localUri: string,
    record: LocalFileRecord,
    remoteChecksum: string,
  ): Promise<void> {
    if (!record.remoteId) {
      throw new Error("Unable to resolve conflict without a remoteId");
    }

    const parentFolder = await this.findParentFolder(localUri);
    const parentRemoteUri = parentFolder?.remoteId;
    if (!parentRemoteUri) {
      throw new Error(
        `Unable to determine parent Drive folder for conflicted notebook ${localUri}`,
      );
    }

    const timestamp = formatTimestamp(new Date());
    const baseName = stripTimestampSuffix(record.name);
    const newName = `${baseName}.${timestamp}.json`;

    const newFile = await this.driveStore.create(parentRemoteUri, newName);
    const localDoc = record.doc ?? "";
    const parseResult = parseSerializedNotebook(localDoc);
    if (parseResult.ok) {
      await this.driveStore.save(newFile.uri, parseResult.notebook);
    } else {
      appLogger.warn(
        "Saving raw local notebook JSON to conflict file because parsing failed",
        {
          attrs: {
            scope: "storage.drive.sync",
            localUri,
            newRemoteUri: newFile.uri,
            error: String(parseResult.error),
          },
        },
      );
      await this.driveStore.saveContent(
        newFile.uri,
        localDoc,
        "application/json",
      );
    }

    let newFileVersion: UpstreamVersion = {};
    try {
      newFileVersion = driveMetadataToUpstreamVersion(
        await this.driveStore.getVersionMetadata(newFile.uri),
      );
    } catch (error) {
      appLogger.warn("Failed to record version metadata for conflict Drive notebook", {
        attrs: {
          scope: "storage.drive.sync",
          localUri,
          remoteUri: newFile.uri,
          error: String(error),
        },
      });
    }

    await this.files.update(localUri, {
      name: newName,
      remoteId: newFile.uri,
      parentRemoteIdWhenCreated: undefined,
      lastRemoteChecksum: newFileVersion.checksum ?? "",
      lastUpstreamVersion: newFileVersion,
      lastSynced: nowIsoString(),
      lastSyncError: undefined,
    });

    console.warn("Notebook conflict resolved by creating a new file", {
      localUri,
      previousRemote: record.remoteId,
      newRemote: newFile.uri,
      previousChecksum: record.lastRemoteChecksum,
      remoteChecksum,
    });

    if (canDispatchWindowEvents()) {
      window.dispatchEvent(
        new CustomEvent("local-notebook-updated", {
          detail: {
            uri: localUri,
            name: newName,
            remoteUri: newFile.uri,
          },
        }),
      );
    }
  }

  private async findParentFolder(
    childUri: string,
  ): Promise<LocalFolderRecord | null> {
    const folder = await this.folders
      .filter((folder) => folder.children.includes(childUri))
      .first();
    return folder ?? null;
  }

  private async syncFolder(localUri: string): Promise<void> {
    const record = await this.folders.get(localUri);
    if (!record) {
      throw new Error(`Local folder not found for ${localUri}`);
    }

    if (!isDriveUri(record.remoteId)) {
      await this.folders.update(localUri, {
        lastSynced: nowIsoString(),
      });
      return;
    }

    try {
      const metadata = await this.driveStore.getMetadata(record.remoteId);
      if (metadata?.name && metadata.name !== record.name) {
        await this.folders.update(localUri, { name: metadata.name });
      }
    } catch (error) {
      console.error(
        "Failed to fetch remote folder metadata for",
        record.remoteId,
        error,
      );
    }

    await this.updateFolder(record.remoteId, record.name);
    await this.folders.update(localUri, {
      lastSynced: nowIsoString(),
    });
  }
}

export default LocalNotebooks;

function checksumForSerializedNotebook(serialized: string): string {
  return serialized ? md5(serialized) : "";
}

function serializeNotebook(notebook: parser_pb.Notebook): string {
  return toJsonString(
    parser_pb.NotebookSchema,
    notebook,
    NOTEBOOK_JSON_WRITE_OPTIONS,
  );
}

function deserializeNotebook(json: string): parser_pb.Notebook {
  if (!json) {
    return create(parser_pb.NotebookSchema, { cells: [] });
  }
  const parsed = parseSerializedNotebook(json);
  if (parsed.ok) {
    return parsed.notebook;
  }
  console.error(
    "Falling back to empty notebook due to parse failure",
    parsed.error,
  );
  return create(parser_pb.NotebookSchema, { cells: [] });
}

function parseSerializedNotebook(json: string):
  | { ok: true; notebook: parser_pb.Notebook }
  | { ok: false; error: unknown } {
  try {
    return {
      ok: true,
      notebook: fromJsonString(parser_pb.NotebookSchema, json, {
        ignoreUnknownFields: true,
      }),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

function serializedNotebookHasUserContent(json: string): boolean {
  if (!json) {
    return false;
  }
  try {
    const notebook = fromJsonString(parser_pb.NotebookSchema, json, {
      ignoreUnknownFields: true,
    });
    return (
      notebook.cells.length > 0 ||
      Object.keys(notebook.metadata ?? {}).length > 0
    );
  } catch (error) {
    appLogger.warn("Preserving unparsable local notebook content", {
      attrs: {
        scope: "storage.drive.sync",
        error: String(error),
      },
    });
    return true;
  }
}

function driveMetadataToUpstreamVersion(
  metadata: DriveVersionMetadata | null,
): UpstreamVersion {
  return {
    checksum: metadata?.md5Checksum,
    revisionId: metadata?.headRevisionId,
  };
}

function syncStateForRecord(
  record: LocalFileRecord,
  status: NotebookSyncStatus,
  fallbackError?: string,
): NotebookSyncState {
  return {
    status,
    localUri: record.id,
    remoteId: record.remoteId,
    parentRemoteIdWhenCreated: record.parentRemoteIdWhenCreated,
    lastSynced: record.lastSynced || undefined,
    lastUpstreamVersion: record.lastUpstreamVersion,
    lastError: record.lastSyncError || fallbackError,
  };
}

function logRemoteOverwriteLocalDoc({
  localUri,
  remoteUri,
  localChecksum,
  remoteChecksum,
  previousUpstreamRevisionId,
  upstreamRevisionId,
  reason,
  localDoc,
  remoteDoc,
}: {
  localUri: string;
  remoteUri: string;
  localChecksum: string;
  remoteChecksum: string;
  previousUpstreamRevisionId?: string;
  upstreamRevisionId?: string;
  reason: string;
  localDoc: string;
  remoteDoc: string;
}): void {
  if (localDoc === remoteDoc) {
    return;
  }
  appLogger.warn("Overwriting local notebook content with upstream content", {
    attrs: {
      scope: "storage.local.sync",
      localUri,
      remoteUri,
      localChecksum,
      remoteChecksum,
      previousUpstreamRevisionId,
      upstreamRevisionId,
      reason,
      localBytes: new TextEncoder().encode(localDoc).byteLength,
      remoteBytes: new TextEncoder().encode(remoteDoc).byteLength,
    },
  });
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function stripTimestampSuffix(name: string): string {
  const match = name.match(/^(.*)\.\d{8}-\d{6}\.json$/);
  if (match && match[1]) {
    return match[1];
  }
  return name.replace(/\.json$/, "");
}

function nowIsoString(): string {
  return new Date().toISOString();
}

function canDispatchWindowEvents(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  );
}

function needsSync(lastSynced: string | undefined, maxAgeMs: number): boolean {
  if (!lastSynced) {
    return true;
  }
  const parsed = Date.parse(lastSynced);
  if (Number.isNaN(parsed)) {
    return true;
  }
  return Date.now() - parsed > maxAgeMs;
}

function isDriveUri(uri: string | undefined): boolean {
  return isDriveItemUri(uri);
}

function isLocalFileUpstream(
  upstreamUri: string | undefined,
  localUri?: string,
): boolean {
  if (!upstreamUri) {
    return false;
  }
  if (localUri && upstreamUri === localUri) {
    return true;
  }
  return upstreamUri.startsWith("local://file/");
}

function publicRemoteUri(record: { id: string; remoteId: string }): string | undefined {
  return isLocalFileUpstream(record.remoteId, record.id)
    ? undefined
    : record.remoteId || undefined;
}

function isFilesystemUri(uri: string | undefined): boolean {
  return uri?.startsWith("fs://") ?? false;
}
