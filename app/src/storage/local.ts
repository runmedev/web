import Dexie, { Table } from "dexie";
import { create, toJsonString, fromJsonString } from "@bufbuild/protobuf";
import { v4 as uuidv4 } from "uuid";
import md5 from "md5";
import { Subject, debounceTime } from "rxjs";

import { parser_pb } from "../runme/client";
import { aisreClientManager as runmeClientManager } from "../lib/aisreClientManager";
import { appState } from "../lib/runtime/AppState";
import { DriveNotebookStore } from "./drive";
import {
  NotebookStoreItem,
  NotebookStoreItemType,
} from "./notebook";

// Local folder URI is a special folder that contains all notebooks which are local (i.e. not synced to Drive)
export const LOCAL_FOLDER_URI = "local://folder/local";

/**
 * LocalFileRecord captures the information needed to persist a notebook locally.
 *
 * The split between `id` and `remoteId` allows us to track notebooks that have
 * never been synced (remoteId === ""), as well as notebooks that originated
 * from Google Drive. `lastRemoteChecksum` lets higher layers perform optimistic
 * concurrency checks before pushing local edits back to Drive.
 */
export interface LocalFileRecord {
  /** Stable local identifier (formatted as local://file/<uuid>). */
  id: string;
  /** Friendly name for the notebook, used when rendering the UI. */
  name: string;
  /** Remote Drive URI if the file is mirrored, otherwise an empty string. */
  remoteId: string;
  /** Remote Drive URI of the Markdown sidecar (e.g. *.index.md) if present. */
  markdownUri?: string;
  /**
   * Checksum returned by the most recent Drive sync. Empty string means the
   * notebook has never been uploaded or the checksum was unavailable.
   */
  lastRemoteChecksum: string;
  /** ISO timestamp of the last successful sync with Drive (empty if never). */
  lastSynced: string;
  /**
   * JSON serialized notebook document. Using a string keeps the IndexedDB
   * representation simple and defers parsing to the caller.
   */
  doc: string;
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

  private readonly syncSubjects = new Map<string, Subject<void>>();
  private readonly markdownSyncSubjects = new Map<string, Subject<void>>();

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
        await tx.table("files").toCollection().modify((file: any) => {
          if (typeof file.lastSynced !== "string") {
            file.lastSynced = "";
          }
        });
        await tx.table("folders").toCollection().modify((folder: any) => {
          if (typeof folder.lastSynced !== "string") {
            folder.lastSynced = "";
          }
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
    const resolvedName =
      existingFolder?.name ??
      name ??
      this.deriveDisplayNameFromUri(remoteUri) ??
      "Untitled Folder";

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

  async getMetadata(uri: string): Promise<NotebookStoreItem | null> {
    if (!uri.startsWith("local://")) {
      throw new Error("getMetadata expects a local:// URI");
    }

    if (uri === LOCAL_FOLDER_URI) {
      const files = await this.files
        .where("remoteId")
        .equals("")
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
        remoteUri: record.remoteId || undefined,
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
        remoteUri: record.remoteId || undefined,
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

    // Enqueue sync
    let subject = this.syncSubjects.get(uri);
    if (!subject) {
      subject = new Subject<void>();
      const DEBOUNCE_TIME_MS = 20*1000; // 20 seconds
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

    // Enqueue markdown sync
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

    const serialized = toJsonString(parser_pb.NotebookSchema, notebook, {
      emitDefaultValues: true,
    });

    await this.files.update(uri, { doc: serialized });
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
      await this.syncFile(uri);

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
    const record: LocalFileRecord = {
      id: fileUri,
      name,
      remoteId: "",
      lastRemoteChecksum: "",
      lastSynced: nowIsoString(),
      doc: "",
    };
    await this.files.put(record);

    await this.folders.update(parentUri, {
      children: [...parent.children, fileUri],
      lastSynced: nowIsoString(),
    });

    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("local-notebook-updated", {
          detail: { uri: fileUri, name, remoteUri: undefined },
        }),
      );
    }

    if (parent.remoteId) {
      void (async () => {
        try {
          const newFile = await this.driveStore.create(parent.remoteId as string, name);
          await this.files.update(fileUri, {
            remoteId: newFile.uri,
          });
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("local-notebook-updated", {
                detail: {
                  uri: fileUri,
                  name: newFile.name ?? name,
                  remoteUri: newFile.uri,
                },
              }),
            );
          }
        } catch (error) {
          console.error("Failed to create remote Drive notebook", error);
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

    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("local-notebook-updated", {
          detail: { uri, name, remoteUri: record.remoteId || undefined },
        }),
      );
    }

    void (async () => {
      if (!record.remoteId) {
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
      remoteUri: record.remoteId || undefined,
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
    if (!record.remoteId) {
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
      markdownBytes = await client.serializeNotebook(notebook, {
        outputs: {
          enabled: true,
          // Summary controls information about execution. I don't think we need that.
          summary: false,
        },
      });
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
      remoteId: "",
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
    const record = await this.files.get(localUri);
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`);
    }

    // Files that do not have a remote counterpart live exclusively in
    // IndexedDB. There is nothing to synchronise for those entries, so we can
    // exit early once we've confirmed the local metadata exists.
    if (!record.remoteId) {
      await this.files.update(localUri, {
        lastSynced: nowIsoString(),
      });
      return;
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
    let currentRemoteChecksum = "";
    try {
      currentRemoteChecksum =
        (await this.driveStore.getChecksum(remoteUri)) ?? "";
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
    const localChecksum = localDoc ? md5(localDoc) : "";
    let synced = false;

    // Case 1: The checksum reported by Drive matches the version we last
    // observed. This means no external party has modified the remote file and
    // the local content is authoritative. We can safely push our data back to
    // Drive without risking data loss.
    if (currentRemoteChecksum === lastReadChecksum) {
      const notebook = deserializeNotebook(localDoc);
      await this.driveStore.save(remoteUri, notebook);
      const updatedChecksum =
        (await this.driveStore.getChecksum(remoteUri)) ?? "";
      await this.files.update(localUri, {
        lastRemoteChecksum: updatedChecksum,
        lastSynced: nowIsoString(),
      });
      synced = true;
      return;
    }

    // Case 2: We have never read the remote file (the cache holds an empty
    // checksum) but Drive reports a concrete checksum. Download the remote
    // copy and store it locally so future edits work against a consistent
    // baseline.
    if (!lastReadChecksum && currentRemoteChecksum) {
      const remoteNotebook = await this.driveStore.load(remoteUri);
      const serialized = toJsonString(
        parser_pb.NotebookSchema,
        remoteNotebook,
        {
          emitDefaultValues: true,
        },
      );
      await this.files.update(localUri, {
        doc: serialized,
        lastRemoteChecksum: currentRemoteChecksum,
        lastSynced: nowIsoString(),
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
        const serialized = toJsonString(
          parser_pb.NotebookSchema,
          remoteNotebook,
          {
            emitDefaultValues: true,
          },
        );
        await this.files.update(localUri, {
          doc: serialized,
          lastRemoteChecksum: currentRemoteChecksum,
          lastSynced: nowIsoString(),
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
        const notebook = deserializeNotebook(localDoc);
        await this.driveStore.save(remoteUri, notebook);
        const updatedChecksum =
          (await this.driveStore.getChecksum(remoteUri)) ?? "";
        await this.files.update(localUri, {
          lastRemoteChecksum: updatedChecksum,
          lastSynced: nowIsoString(),
        });
        synced = true;
      } else if (lastReadChecksum) {
        await this.files.update(localUri, {
          lastRemoteChecksum: "",
          lastSynced: nowIsoString(),
        });
        synced = true;
      }
    }

    if (!synced) {
      await this.files.update(localUri, {
        lastSynced: nowIsoString(),
      });
    }
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
    const notebook = deserializeNotebook(record.doc ?? "");
    await this.driveStore.save(newFile.uri, notebook);

    await this.files.update(localUri, {
      name: newName,
      remoteId: newFile.uri,
      lastRemoteChecksum: "",
      lastSynced: nowIsoString(),
    });

    console.warn("Notebook conflict resolved by creating a new file", {
      localUri,
      previousRemote: record.remoteId,
      newRemote: newFile.uri,
      previousChecksum: record.lastRemoteChecksum,
      remoteChecksum,
    });

    if (typeof window !== "undefined") {
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
    return this.folders
      .filter((folder) => folder.children.includes(childUri))
      .first();
  }

  private async syncFolder(localUri: string): Promise<void> {
    const record = await this.folders.get(localUri);
    if (!record) {
      throw new Error(`Local folder not found for ${localUri}`);
    }

    if (!record.remoteId) {
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

function deserializeNotebook(json: string): parser_pb.Notebook {
  if (!json) {
    return create(parser_pb.NotebookSchema, { cells: [] });
  }
  try {
    return fromJsonString(parser_pb.NotebookSchema, json, {
      ignoreUnknownFields: true,
    });
  } catch (error) {
    console.error("Falling back to empty notebook due to parse failure", error);
    return create(parser_pb.NotebookSchema, { cells: [] });
  }
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
