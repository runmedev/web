import { create, fromJsonString, toJsonString } from '@bufbuild/protobuf'
import Dexie, { Table } from 'dexie'
import md5 from 'md5'
import { Subject, debounceTime } from 'rxjs'
import { v4 as uuidv4 } from 'uuid'

import { migrateNotebookCellIds } from '../lib/cellIdentity'
import { IPYNB_MIME_TYPE } from '../lib/ipynb'
import { appLogger } from '../lib/logging/runtime'
import { serializeNotebookToMarkdown } from '../lib/markdown/serializeNotebookToMarkdown'
import {
  RUNME_OPERATION_LOG_MIME_TYPE,
  convertLegacyNotebookFileToRunme,
  createInitialNotebookFile,
  decodeNotebookFile,
  detectNotebookFileFormat,
  encodeIpynbNotebook,
  encodeRunmeOperationLogSnapshotWithHeader,
  isNotebookFileName,
  notebookFileExtension,
  validateNotebookRenameFormat,
} from '../lib/notebookFormat'
import {
  type CommentAddPayload,
  type CommentReplyPayload,
  type JsonValue,
  type ParsedOperationLog,
  type RunmeOperation,
  buildOperationLogDiff,
  canonicalJson,
  causalHeads,
  cloneNotebook,
  createRunmeOperation,
  getNotebookActorId,
  highestActorSequence,
  materializeOperationLog,
  materializedLogToNotebook,
  mergeOperationSets,
  parseOperationLog,
  serializeOperationLog,
} from '../lib/operationLog'
import { appState } from '../lib/runtime/AppState'
import { RunmeMetadataKey, parser_pb } from '../runme/client'
import {
  type ConflictDocStorage,
  type ConflictDocumentRef,
  createDefaultConflictDocStorage,
} from './conflictDocs'
import {
  type DriveComment,
  DriveNotebookStore,
  type DriveRevision,
  type DriveVersionMetadata,
  driveFileUrl,
  driveFolderUrl,
  isDriveItemUri,
  parseDriveItem,
} from './drive'
import {
  type DriveSyncCoordinator,
  browserDriveSyncCoordinator,
} from './driveSyncCoordinator'
import { EXCALIDRAW_MIME_TYPE, isExcalidrawFileName } from './excalidraw'
import type { FilesystemNotebookStore } from './fs'
import {
  type IpynbPreservationState,
  type IpynbShadowStorage,
  createDefaultIpynbShadowStorage,
} from './ipynbShadows'
import { NotebookStoreItem, NotebookStoreItemType } from './notebook'
import {
  type OperationLogRef,
  type OperationLogStorage,
  createDefaultOperationLogStorage,
} from './operationLogs'
import {
  type RevisionDocStorage,
  createDefaultRevisionDocStorage,
} from './revisionDocs'

// Local folder URI is a special folder that contains all notebooks which are local (i.e. not synced to Drive)
export const LOCAL_FOLDER_URI = 'local://folder/local'

const NOTEBOOK_JSON_WRITE_OPTIONS = {
  emitDefaultValues: true,
} as unknown as Parameters<typeof toJsonString>[2]

const NOTEBOOK_MIME_TYPE = 'application/json'

// A Drive folder listing can briefly lag a successful file create. Preserve a
// directly attached child long enough for that index to settle, but eventually
// let authoritative listings remove files that were moved or trashed elsewhere.
const PROVISIONAL_DRIVE_CHILD_TTL_MS = 60_000

// A collaborator can win several Drive compare-and-swap races in a row while
// both sessions are actively editing. Each attempt performs network I/O, so a
// larger bounded budget improves convergence without creating a tight loop.
const DRIVE_OPERATION_LOG_MERGE_ATTEMPTS = 8

/**
 * LocalFileRecord captures the information needed to persist a notebook locally.
 *
 * The split between `id` and `remoteId` allows us to keep one stable local
 * identity while tracking the upstream URI that owns the authoritative external
 * resource. Browser-only notebooks use the local URI as their upstream URI.
 */
export interface LocalFileRecord {
  /** Stable local identifier (formatted as local://file/<uuid>). */
  id: string
  /** Friendly name for the notebook, used when rendering the UI. */
  name: string
  /** Content MIME type used to select the document renderer. */
  mimeType?: string
  /** Upstream URI. Browser-only notebooks use the same local://file/... URI. */
  remoteId: string
  /** Creation-time upstream parent URI used to finish a pending remote create. */
  parentRemoteIdWhenCreated?: string
  /** Stable idempotency key for creating the primary Drive file. */
  driveCreateOperationId?: string
  /** Retry state retained only while a legacy-to-Runme Drive copy is pending. */
  legacyConversionAttempt?: {
    originalGoogleDriveId: string
    sourceChecksum: string
  }
  /** Remote Drive URI of the Markdown sidecar (e.g. *.index.md) if present. */
  markdownUri?: string
  /** Stable idempotency key for creating the Markdown sidecar. */
  markdownCreateOperationId?: string
  /**
   * Checksum returned by the most recent Drive sync. Empty string means the
   * notebook has never been uploaded or the checksum was unavailable.
   */
  lastRemoteChecksum: string
  /** ISO timestamp of the last successful sync with Drive (empty if never). */
  lastSynced: string
  /** Last successfully observed upstream revision/checksum metadata. */
  lastUpstreamVersion?: UpstreamVersion
  /** Last sync failure, if any. Cleared after successful sync. */
  lastSyncError?: string
  /** Durable local-vs-upstream conflict snapshot, if upstream sync is blocked. */
  conflict?: NotebookConflictState
  /**
   * JSON serialized notebook document. Using a string keeps the IndexedDB
   * representation simple and defers parsing to the caller.
   */
  doc: string
  /**
   * MD5 checksum of `doc`. Persisted so reconciler scans can detect local
   * changes without re-hashing every file on each pass.
   */
  md5Checksum: string
  /** Lossless .ipynb merge metadata. The complete shadow lives in OPFS. */
  ipynbPreservation?: IpynbPreservationState
  /** Authoritative .runme document location. IndexedDB never stores its bytes. */
  operationLogRef?: OperationLogRef
}

export interface UpstreamVersion {
  checksum?: string
  revisionId?: string
  modifiedTime?: string
  sizeBytes?: number
}

export interface NotebookConflictState {
  detectedAt: string
  upstreamChecksum: string
  upstreamVersion?: UpstreamVersion
  upstreamDocRef?: ConflictDocumentRef
  /** @deprecated Legacy inline conflict payload. New records store this in OPFS. */
  upstreamDoc?: string
  localChecksumAtDetection: string
}

export interface NotebookConflictSummary {
  detectedAt: string
  upstreamChecksum: string
  upstreamVersion?: UpstreamVersion
  upstreamDocRef?: ConflictDocumentRef
  upstreamDocSizeBytes?: number
  localChecksumAtDetection: string
}

export type NotebookSyncStatus =
  | 'local-only'
  | 'synced'
  | 'pending'
  | 'pending-upstream-create'
  | 'syncing'
  | 'conflicted'
  | 'error'

export interface NotebookSyncState {
  status: NotebookSyncStatus
  localUri: string
  remoteId: string
  parentRemoteIdWhenCreated?: string
  lastSynced?: string
  lastUpstreamVersion?: UpstreamVersion
  conflict?: NotebookConflictSummary
  lastError?: string
}

export interface NotebookSyncStatusRow {
  localUri: string
  title: string
  googleDriveUrl: string
  revision: string
  upstreamRevision: string
  lastSynced?: string
  syncStatus: NotebookSyncStatus
  lastError?: string
}

export class NotebookConflictChangedError extends Error {
  constructor(
    readonly localUri: string,
    readonly conflictChecksum: string,
    readonly currentUpstreamChecksum: string
  ) {
    super(
      `Upstream changed after conflict detection for ${localUri}: ` +
        `${conflictChecksum} -> ${currentUpstreamChecksum}`
    )
    this.name = 'NotebookConflictChangedError'
  }
}

export class DriveSnapshotChangedError extends Error {
  constructor(readonly remoteUri: string) {
    super(`Google Drive changed while importing ${remoteUri}. Please retry.`)
    this.name = 'DriveSnapshotChangedError'
  }
}

function driveVersionMatches(
  actual: DriveVersionMetadata | null,
  expected: { checksum?: string; revisionId?: string; version?: string }
): boolean {
  return (
    (expected.checksum === undefined ||
      actual?.md5Checksum === expected.checksum) &&
    (expected.revisionId === undefined ||
      actual?.headRevisionId === expected.revisionId) &&
    (expected.version === undefined || actual?.version === expected.version)
  )
}

function sameDriveVersion(
  before: DriveVersionMetadata | null,
  after: DriveVersionMetadata | null
): boolean {
  return (
    before?.md5Checksum === after?.md5Checksum &&
    before?.headRevisionId === after?.headRevisionId &&
    before?.version === after?.version
  )
}

/**
 * LocalFolderRecord represents a folder in the mirrored hierarchy.
 *
 * Children entries always use *local* URIs so the UI can work offline. When a
 * remote Drive folder exists we also track its origin through `remoteId`.
 */
export interface LocalFolderRecord {
  /** Stable local identifier (formatted as local://folder/<uuid>). */
  id: string
  /** Friendly name for the folder when displayed locally. */
  name: string
  /** Remote Drive URI if the folder is mirrored, otherwise an empty string. */
  remoteId: string
  /**
   * Local URIs for the children contained in this folder. The array keeps the
   * ordering stable and allows quick traversal when rendering the notebook tree.
   */
  children: string[]
  /**
   * Children attached by a direct Drive create but not yet observed in a Drive
   * folder listing. A stale eventual-consistency response must not remove them.
   */
  provisionalChildren?: string[]
  /** Creation time for each provisional attachment, used to bound retention. */
  provisionalChildrenAttachedAt?: Record<string, number>
  /** ISO timestamp of the last successful sync with Drive (empty if never). */
  lastSynced: string
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
  files!: Table<LocalFileRecord, string>

  /** IndexedDB table where folder metadata is stored. */
  folders!: Table<LocalFolderRecord, string>

  private readonly driveStore: DriveNotebookStore
  private readonly driveSyncCoordinator: DriveSyncCoordinator
  private filesystemStore: FilesystemNotebookStore | null = null
  private readonly conflictDocStorage: ConflictDocStorage
  private readonly revisionDocStorage: RevisionDocStorage
  private readonly ipynbShadowStorage: IpynbShadowStorage
  private readonly operationLogStorage: OperationLogStorage

  private readonly syncSubjects = new Map<string, Subject<void>>()
  private readonly markdownSyncSubjects = new Map<string, Subject<void>>()
  private readonly inFlightSyncs = new Map<string, Promise<void>>()
  private readonly syncListeners = new Map<string, Set<() => void>>()

  constructor(
    driveStore: DriveNotebookStore,
    databaseName: string = 'runme-local-notebooks',
    conflictDocStorage: ConflictDocStorage = createDefaultConflictDocStorage(),
    revisionDocStorage: RevisionDocStorage = createDefaultRevisionDocStorage(),
    driveSyncCoordinator: DriveSyncCoordinator = browserDriveSyncCoordinator,
    ipynbShadowStorage: IpynbShadowStorage = createDefaultIpynbShadowStorage(),
    operationLogStorage: OperationLogStorage = createDefaultOperationLogStorage()
  ) {
    super(databaseName)

    // Define the database schema. Version(1) gives us a clear starting point
    // for future migrations. Both tables are keyed by the `id` property.
    this.version(1).stores({
      files: '&id, remoteId, lastRemoteChecksum, name',
      folders: '&id, remoteId, name',
    })
    this.version(2)
      .stores({
        files: '&id, remoteId, lastRemoteChecksum, name, lastSynced',
        folders: '&id, remoteId, name, lastSynced',
      })
      .upgrade(async (tx) => {
        await tx
          .table('files')
          .toCollection()
          .modify((file: Partial<LocalFileRecord>) => {
            if (typeof file.lastSynced !== 'string') {
              file.lastSynced = ''
            }
          })
        await tx
          .table('folders')
          .toCollection()
          .modify((folder: Partial<LocalFolderRecord>) => {
            if (typeof folder.lastSynced !== 'string') {
              folder.lastSynced = ''
            }
          })
      })
    this.version(3)
      .stores({
        files:
          '&id, remoteId, lastRemoteChecksum, md5Checksum, name, lastSynced',
        folders: '&id, remoteId, name, lastSynced',
      })
      .upgrade(async (tx) => {
        await tx
          .table('files')
          .toCollection()
          .modify((file: Partial<LocalFileRecord>) => {
            if (typeof file.md5Checksum !== 'string') {
              // Lazy backfill: keep migration cheap and compute missing checksums
              // when we evaluate whether a file needs syncing.
              file.md5Checksum = ''
            }
          })
      })
    this.version(4)
      .stores({
        files:
          '&id, remoteId, lastRemoteChecksum, md5Checksum, name, lastSynced',
        folders: '&id, remoteId, name, lastSynced',
      })
      .upgrade(async (tx) => {
        await tx
          .table('files')
          .toCollection()
          .modify((file: Partial<LocalFileRecord>) => {
            if (typeof file.remoteId !== 'string' || file.remoteId === '') {
              file.remoteId = file.id ?? ''
            }
          })
      })
    this.version(5)
      .stores({
        files:
          '&id, remoteId, lastRemoteChecksum, md5Checksum, name, lastSynced',
        folders: '&id, remoteId, name, lastSynced',
      })
      .upgrade(async (tx) => {
        await tx
          .table('files')
          .toCollection()
          .modify((file: Partial<LocalFileRecord>) => {
            delete file.lastUpstreamVersion
            delete file.lastSyncError
            delete file.parentRemoteIdWhenCreated
          })
      })
    this.version(6).stores({
      files: '&id, remoteId, lastRemoteChecksum, md5Checksum, name, lastSynced',
      folders: '&id, remoteId, name, lastSynced',
    })

    // Bind the table helpers so callers can access them directly.
    this.files = this.table('files')
    this.folders = this.table('folders')

    this.driveStore = driveStore
    this.driveSyncCoordinator = driveSyncCoordinator
    this.conflictDocStorage = conflictDocStorage
    this.revisionDocStorage = revisionDocStorage
    this.ipynbShadowStorage = ipynbShadowStorage
    this.operationLogStorage = operationLogStorage

    void this.ensureFolderRecord(LOCAL_FOLDER_URI, 'Local Notebooks')
  }

  setFilesystemStore(store: FilesystemNotebookStore | null): void {
    this.filesystemStore = store
  }

  /**
   * Ensure that the given remote file has a local representation and return its
   * local URI. If the file has already been mirrored we simply hand back the
   * existing identifier.
   */
  async addFile(
    remoteUri: string,
    name?: string,
    options?: { mimeType?: string }
  ): Promise<string> {
    if (!remoteUri) {
      throw new Error('addFile requires a non-empty remote URI')
    }

    return this.driveSyncCoordinator.runExclusive(
      this.fileMirrorLockKey(remoteUri),
      () => this.addFileInner(remoteUri, name, options)
    )
  }

  /**
   * Import one stable Drive snapshot without exposing candidate bytes to the
   * notebook UI. This is the shared-link boundary: metadata is checked before
   * and after the download, and only a consistent snapshot initializes the
   * local mirror that openNotebook can render.
   */
  async importTrustedDriveSnapshot(
    remoteUri: string,
    name: string,
    options: {
      mimeType?: string
      expected?: { checksum?: string; revisionId?: string; version?: string }
    } = {}
  ): Promise<string> {
    const localUri = await this.addFile(remoteUri, name, {
      mimeType: options.mimeType,
    })
    const record = await this.files.get(localUri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`)
    }

    // Existing mirrors have already crossed a user- or policy-authorized
    // import boundary. Preserve possible local edits and let normal sync and
    // conflict handling own subsequent refreshes.
    if (!isUninitializedDriveMirror(record)) {
      return localUri
    }

    const expected = options.expected ?? {}
    const before = await this.driveStore.getVersionMetadata(remoteUri)
    if (!driveVersionMatches(before, expected)) {
      throw new DriveSnapshotChangedError(remoteUri)
    }

    const content = await this.driveStore.loadContent(remoteUri)
    const after = await this.driveStore.getVersionMetadata(remoteUri)
    if (
      !sameDriveVersion(before, after) ||
      !driveVersionMatches(after, expected)
    ) {
      throw new DriveSnapshotChangedError(remoteUri)
    }

    if (
      content === '' &&
      detectNotebookFileFormat(record.name) === 'runme-operation-log'
    ) {
      // Preserve the validated trust boundary: claim exactly the Drive
      // revision checked above rather than starting an unconstrained refresh.
      const initialDocument = createInitialNotebookFile(record.name)
      const saved = await this.driveStore.saveContentIfVersion(
        remoteUri,
        initialDocument,
        RUNME_OPERATION_LOG_MIME_TYPE,
        {
          checksum: after?.md5Checksum,
          revisionId: after?.headRevisionId,
          version: after?.version,
        }
      )
      if (!saved) {
        throw new DriveSnapshotChangedError(remoteUri)
      }
      const initializedSnapshot =
        await this.loadConsistentDriveOperationLogSnapshot(remoteUri)
      if (
        !initializedSnapshot ||
        initializedSnapshot.content !== initialDocument
      ) {
        throw new DriveSnapshotChangedError(remoteUri)
      }
      await this.initializeUploadedDriveNotebook(
        localUri,
        create(parser_pb.NotebookSchema, { cells: [] }),
        initialDocument,
        driveMetadataToUpstreamVersion(initializedSnapshot.version)
      )
      return localUri
    }

    const decoded = decodeNotebookFile(content, name)
    await this.initializeUploadedDriveNotebook(
      localUri,
      decoded.notebook,
      content,
      driveMetadataToUpstreamVersion(after)
    )
    return localUri
  }

  private fileMirrorLockKey(remoteUri: string): string {
    try {
      const item = parseDriveItem(remoteUri)
      if (item.type === NotebookStoreItemType.File) {
        return `file-mirror:${driveFileUrl(item.id)}`
      }
    } catch {
      // Non-Drive upstreams still receive deterministic in-process locking.
    }
    return `file-mirror:${remoteUri}`
  }

  private async addFileInner(
    remoteUri: string,
    name?: string,
    options?: { mimeType?: string }
  ): Promise<string> {
    const existing = await this.files
      .where('remoteId')
      .equals(remoteUri)
      .first()
    if (existing) {
      const changes: Partial<LocalFileRecord> = {}
      if (name && name !== existing.name) {
        changes.name = name
      }
      const mimeType = resolveDocumentMimeType(name, options?.mimeType)
      if (mimeType && mimeType !== existing.mimeType) {
        changes.mimeType = mimeType
      }
      if (Object.keys(changes).length > 0) {
        await this.files.update(existing.id, changes)
      }
      return existing.id
    }

    const id = this.generateLocalUri('file')
    const resolvedName =
      name ?? this.deriveDisplayNameFromUri(remoteUri) ?? 'Untitled Notebook'
    const mimeType = resolveDocumentMimeType(resolvedName, options?.mimeType)

    const record: LocalFileRecord = {
      id,
      name: resolvedName,
      mimeType,
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    }

    await this.files.put(record)
    return id
  }

  /**
   * Attach an already-created Drive mirror to every matching mounted folder.
   * Folder membership uses a Drive-ID comparison so share-link query variants
   * and canonical folder URLs resolve to the same Drive folder. Multiple local
   * records can exist for equivalent mounts, and each visible tree must receive
   * the new child and its update event.
   */
  async attachDriveFileToFolder(
    remoteFolderUri: string,
    localFileUri: string
  ): Promise<string | null> {
    const target = parseDriveItem(remoteFolderUri)
    if (target.type !== NotebookStoreItemType.Folder) {
      throw new Error('attachDriveFileToFolder requires a Drive folder URI')
    }

    return this.driveSyncCoordinator.runExclusive(
      `file-parent:${localFileUri}`,
      async () => {
        const file = await this.files.get(localFileUri)
        if (!file) {
          throw new Error(`Local file record not found for ${localFileUri}`)
        }
        const currentParents = await this.folders
          .filter((record) => record.children.includes(localFileUri))
          .toArray()
        for (const currentParent of currentParents) {
          let isDifferentDriveFolder = false
          try {
            const candidate = parseDriveItem(currentParent.remoteId)
            isDifferentDriveFolder =
              candidate.type === NotebookStoreItemType.Folder &&
              candidate.id !== target.id
          } catch {
            // Non-Drive folder membership is outside this reconciliation path.
          }
          if (isDifferentDriveFolder) {
            await this.mutateFolderChildren(currentParent.id, (children) =>
              children.filter((childUri) => childUri !== localFileUri)
            )
          }
        }

        return this.driveSyncCoordinator.runExclusive(
          this.driveFolderMembershipLockKey(remoteFolderUri),
          async () => {
            let folders = await this.folders
              .filter((record) => {
                try {
                  const candidate = parseDriveItem(record.remoteId)
                  return (
                    candidate.type === NotebookStoreItemType.Folder &&
                    candidate.id === target.id
                  )
                } catch {
                  return false
                }
              })
              .toArray()
            if (folders.length === 0) {
              // Direct creation can overlap the first mount of this Drive folder.
              // Materialize the local folder now so a stale first Drive listing
              // cannot discard the new child's only parent association.
              const canonicalRemoteUri = driveFolderUrl(target.id)
              const provisionalFolder: LocalFolderRecord = {
                id: this.generateLocalUri('folder'),
                name:
                  this.deriveDisplayNameFromUri(canonicalRemoteUri) ??
                  'Untitled Folder',
                remoteId: canonicalRemoteUri,
                children: [],
                lastSynced: '',
              }
              await this.folders.put(provisionalFolder)
              folders = [provisionalFolder]
            }

            for (const folder of folders) {
              const attachedAt = {
                ...(folder.provisionalChildrenAttachedAt ?? {}),
                [localFileUri]:
                  folder.provisionalChildrenAttachedAt?.[localFileUri] ??
                  Date.now(),
              }
              if (!folder.children.includes(localFileUri)) {
                await this.folders.update(folder.id, {
                  children: [...folder.children, localFileUri],
                  provisionalChildren: [
                    ...new Set([
                      ...(folder.provisionalChildren ?? []),
                      localFileUri,
                    ]),
                  ],
                  provisionalChildrenAttachedAt: attachedAt,
                  lastSynced: nowIsoString(),
                })
              } else if (
                !(folder.provisionalChildren ?? []).includes(localFileUri) ||
                folder.provisionalChildrenAttachedAt?.[localFileUri] ===
                  undefined
              ) {
                await this.folders.update(folder.id, {
                  provisionalChildren: [
                    ...(folder.provisionalChildren ?? []),
                    localFileUri,
                  ],
                  provisionalChildrenAttachedAt: attachedAt,
                })
              }
              if (canDispatchWindowEvents()) {
                window.dispatchEvent(
                  new CustomEvent('local-notebook-updated', {
                    detail: {
                      uri: localFileUri,
                      name: file.name,
                      remoteUri: publicRemoteUri(file),
                      parentUri: folder.id,
                    },
                  })
                )
              }
            }
            return folders[0].id
          }
        )
      }
    )
  }

  /**
   * Ensure that a loaded notebook from an upstream file has a local editable
   * mirror and return the local URI for editor/tab state.
   */
  async addNotebook(
    upstreamUri: string,
    name: string,
    notebook: parser_pb.Notebook
  ): Promise<string> {
    if (!upstreamUri) {
      throw new Error('addNotebook requires a non-empty upstream URI')
    }

    const serialized = serializeNotebook(notebook)
    const checksum = checksumForSerializedNotebook(serialized)
    const existing = await this.files
      .where('remoteId')
      .equals(upstreamUri)
      .first()

    if (existing) {
      const existingChecksum = await this.getOrBackfillLocalChecksum(
        existing.id,
        existing
      )
      const existingBaseline = existing.lastRemoteChecksum ?? ''
      const hasLocalChanges =
        existing.doc !== '' && existingChecksum !== existingBaseline
      if (hasLocalChanges) {
        appLogger.warn(
          'Preserving local mirror while opening changed upstream notebook',
          {
            attrs: {
              scope: 'storage.local.mirror',
              localUri: existing.id,
              upstreamUri,
              localChecksum: existingChecksum,
              upstreamChecksum: checksum,
              lastRemoteChecksum: existingBaseline,
            },
          }
        )
        const changes: Partial<LocalFileRecord> = { name }
        if (checksum !== existingBaseline) {
          changes.conflict = await this.createConflictState({
            localUri: existing.id,
            upstreamDoc: serialized,
            upstreamChecksum: checksum,
            upstreamVersion: { checksum },
            localChecksumAtDetection: existingChecksum,
          })
          changes.lastSyncError = undefined
        }
        await this.files.update(existing.id, changes)
      } else {
        await this.files.update(existing.id, {
          name,
          doc: serialized,
          md5Checksum: checksum,
          lastRemoteChecksum: checksum,
          lastUpstreamVersion: { checksum },
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
          conflict: undefined,
        })
      }
      return existing.id
    }

    const id = this.generateLocalUri('file')
    const record: LocalFileRecord = {
      id,
      name,
      mimeType: NOTEBOOK_MIME_TYPE,
      remoteId: upstreamUri,
      lastRemoteChecksum: checksum,
      lastUpstreamVersion: { checksum },
      lastSynced: nowIsoString(),
      doc: serialized,
      md5Checksum: checksum,
    }

    await this.files.put(record)
    return id
  }

  /**
   * Initialize the local mirror immediately after this client uploaded a new
   * Drive notebook. Recording both the raw upstream fingerprint and the
   * decoded notebook baseline prevents the first editor load from treating the
   * two representations as concurrent edits.
   */
  async initializeUploadedDriveNotebook(
    localUri: string,
    notebook: parser_pb.Notebook,
    upstreamContent: string,
    upstreamVersion: UpstreamVersion = {}
  ): Promise<boolean> {
    return this.driveSyncCoordinator.runExclusive(localUri, async () => {
      const record = await this.files.get(localUri)
      if (!record) {
        throw new Error(`Local notebook record not found for ${localUri}`)
      }
      if (!isDriveUri(record.remoteId)) {
        throw new Error(
          `Uploaded notebook mirror requires a Drive remote URI; got ${record.remoteId}`
        )
      }

      // addFile returns an existing mirror for an already-known remote URI. An
      // idempotent create retry must never reset that mirror because it may hold
      // unsynced edits or an active conflict. The caller reconciles it through
      // the normal Drive sync path instead.
      if (!isUninitializedDriveMirror(record)) {
        return false
      }

      const upstreamChecksum = upstreamVersion.checksum ?? md5(upstreamContent)
      const format = detectNotebookFileFormat(record.name)
      let operationLogRef: OperationLogRef | undefined
      const decoded =
        format === 'ipynb'
          ? await this.decodeUpstreamNotebook({
              localUri,
              record,
              content: upstreamContent,
              upstreamFingerprint: upstreamChecksum,
            })
          : format === 'runme-operation-log'
            ? {
                notebook: decodeNotebookFile(upstreamContent, record.name)
                  .notebook,
                serialized: '',
              }
            : { notebook, serialized: serializeNotebook(notebook) }
      if (format === 'runme-operation-log') {
        operationLogRef = (
          await this.operationLogStorage.initialize(localUri, upstreamContent)
        ).ref
      }
      const localChecksum =
        format === 'runme-operation-log'
          ? md5(upstreamContent)
          : checksumForSerializedNotebook(decoded.serialized)
      let initialized = false

      // The Web Lock serializes Drive sync work across tabs. The IndexedDB
      // transaction also re-checks the record immediately before updating so a
      // local edit that does not take that lock cannot be overwritten.
      await this.transaction('rw', this.files, async () => {
        const current = await this.files.get(localUri)
        if (
          !current ||
          current.remoteId !== record.remoteId ||
          current.name !== record.name ||
          !isUninitializedDriveMirror(current)
        ) {
          return
        }
        await this.files.update(localUri, {
          doc: decoded.serialized,
          md5Checksum: localChecksum,
          lastRemoteChecksum: upstreamChecksum,
          lastUpstreamVersion: {
            ...upstreamVersion,
            checksum: upstreamChecksum,
          },
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
          conflict: undefined,
          ipynbPreservation: decoded.ipynbPreservation,
          operationLogRef,
        })
        initialized = true
      })

      if (!initialized) {
        const latest = await this.files.get(localUri)
        const unusedShadow = decoded.ipynbPreservation?.shadowRef
        if (
          unusedShadow &&
          latest?.ipynbPreservation?.shadowRef.path !== unusedShadow.path
        ) {
          await this.ipynbShadowStorage.delete(unusedShadow).catch(() => {})
        }
        return false
      }

      await this.deleteReplacedIpynbShadow(
        record.ipynbPreservation,
        decoded.ipynbPreservation
      )
      this.notifySync(localUri)
      this.enqueueMarkdownSync(localUri)
      return true
    })
  }

  /** Reconcile an existing Drive mirror without discarding local edits. */
  async reconcileDriveNotebook(localUri: string): Promise<void> {
    await this.syncFile(localUri)
  }

  /**
   * Mirror the contents of a remote folder into IndexedDB. Every Drive file
   * discovered is guaranteed to have a local entry afterwards and the folder's
   * `children` array is updated to reflect the latest local URIs.
   */
  async updateFolder(remoteUri: string, name?: string): Promise<string> {
    if (!remoteUri) {
      throw new Error('updateFolder requires a non-empty remote URI')
    }

    return this.driveSyncCoordinator.runExclusive(
      this.driveFolderMembershipLockKey(remoteUri),
      () => this.updateFolderInner(remoteUri, name)
    )
  }

  private driveFolderMembershipLockKey(remoteUri: string): string {
    const item = parseDriveItem(remoteUri)
    if (item.type !== NotebookStoreItemType.Folder) {
      throw new Error('Drive folder membership requires a folder URI')
    }
    return `folder-membership:${driveFolderUrl(item.id)}`
  }

  private async mutateFolderChildren(
    folderId: string,
    mutate: (children: string[]) => string[]
  ): Promise<void> {
    const initial = await this.folders.get(folderId)
    if (!initial) {
      throw new Error(`Local folder record not found for ${folderId}`)
    }
    const lockKey = isDriveUri(initial.remoteId)
      ? this.driveFolderMembershipLockKey(initial.remoteId)
      : `folder-membership:${initial.id}`
    await this.driveSyncCoordinator.runExclusive(lockKey, async () => {
      const current = await this.folders.get(folderId)
      if (!current) {
        throw new Error(`Local folder record not found for ${folderId}`)
      }
      const nextChildren = mutate([...current.children])
      const nextProvisionalChildren = (
        current.provisionalChildren ?? []
      ).filter((childUri) => nextChildren.includes(childUri))
      const nextProvisionalChildrenAttachedAt = Object.fromEntries(
        nextProvisionalChildren.map((childUri) => [
          childUri,
          current.provisionalChildrenAttachedAt?.[childUri] ?? Date.now(),
        ])
      )
      await this.folders.update(folderId, {
        children: nextChildren,
        provisionalChildren: nextProvisionalChildren,
        provisionalChildrenAttachedAt: nextProvisionalChildrenAttachedAt,
        lastSynced: nowIsoString(),
      })
    })
  }

  private async updateFolderInner(
    remoteUri: string,
    name?: string
  ): Promise<string> {
    let existingFolder = await this.folders
      .where('remoteId')
      .equals(remoteUri)
      .first()
    if (!existingFolder) {
      const target = parseDriveItem(remoteUri)
      existingFolder = await this.folders
        .filter((record) => {
          try {
            const candidate = parseDriveItem(record.remoteId)
            return (
              target.type === NotebookStoreItemType.Folder &&
              candidate.type === NotebookStoreItemType.Folder &&
              candidate.id === target.id
            )
          } catch {
            return false
          }
        })
        .first()
    }

    const folderId = existingFolder?.id ?? this.generateLocalUri('folder')
    const fallbackName =
      this.deriveDisplayNameFromUri(remoteUri) ?? 'Untitled Folder'
    let resolvedName = name ?? existingFolder?.name ?? fallbackName

    // When callers don't provide a name, resolve the remote folder metadata so
    // new mounts use the human-readable Drive name instead of an id-derived
    // fallback. If an existing record still has that fallback name, upgrade it.
    if (
      !name &&
      (!existingFolder ||
        existingFolder.name === fallbackName ||
        existingFolder.name === 'Drive')
    ) {
      try {
        const metadata = await this.driveStore.getMetadata(remoteUri)
        const remoteName = metadata?.name?.trim()
        if (remoteName) {
          resolvedName = remoteName
        }
      } catch (error) {
        console.error(
          'Failed to resolve Drive folder name from metadata',
          remoteUri,
          error
        )
      }
    }

    // Ensure the folder exists locally before we populate it.
    if (!existingFolder) {
      const initialRecord: LocalFolderRecord = {
        id: folderId,
        name: resolvedName,
        remoteId: remoteUri,
        children: [],
        lastSynced: '',
      }
      await this.folders.put(initialRecord)
    } else if (existingFolder.name !== resolvedName) {
      await this.folders.update(folderId, { name: resolvedName })
    }

    // Fetch the latest Drive listing and mirror any notebooks we discover.
    const items = await this.driveStore.list(remoteUri)
    const childUris: string[] = []

    for (const item of items) {
      if (item.type === NotebookStoreItemType.File) {
        const localUri = await this.addFile(item.uri, item.name, {
          mimeType: item.mimeType,
        })
        childUris.push(localUri)
      } else if (item.type === NotebookStoreItemType.Folder) {
        const localFolderUri = await this.updateFolder(item.uri, item.name)
        childUris.push(localFolderUri)
      }
    }

    const existingChildren = existingFolder?.children ?? []
    for (const childUri of existingChildren) {
      const childRecord = childUri.startsWith('local://file/')
        ? await this.files.get(childUri)
        : null
      if (
        childRecord?.remoteId === '' &&
        childRecord.parentRemoteIdWhenCreated === remoteUri &&
        !childUris.includes(childUri)
      ) {
        childUris.push(childUri)
      }
    }

    // Drive folder listings can lag a successful create. Keep direct
    // attachments until at least one listing confirms them, then clear the
    // provisional marker so later refreshes reflect Drive normally.
    const listedChildren = new Set(childUris)
    const now = Date.now()
    const provisionalChildren = (
      existingFolder?.provisionalChildren ?? []
    ).filter((childUri) => {
      if (listedChildren.has(childUri)) {
        return false
      }
      const attachedAt =
        existingFolder?.provisionalChildrenAttachedAt?.[childUri] ?? now
      return now - attachedAt < PROVISIONAL_DRIVE_CHILD_TTL_MS
    })
    const provisionalChildrenAttachedAt = Object.fromEntries(
      provisionalChildren.map((childUri) => [
        childUri,
        existingFolder?.provisionalChildrenAttachedAt?.[childUri] ?? now,
      ])
    )
    for (const childUri of provisionalChildren) {
      if (!childUris.includes(childUri) && (await this.files.get(childUri))) {
        childUris.push(childUri)
      }
    }

    await this.folders.update(folderId, {
      name: resolvedName,
      children: childUris,
      provisionalChildren,
      provisionalChildrenAttachedAt,
    })

    return folderId
  }

  async sync(localUri: string): Promise<void> {
    if (localUri.startsWith('local://file/')) {
      await this.syncFile(localUri)
      return
    }

    if (localUri.startsWith('local://folder/')) {
      await this.syncFolder(localUri)
      return
    }

    throw new Error(`Unsupported local URI format: ${localUri}`)
  }

  subscribeSync(localUri: string, listener: () => void): () => void {
    let listeners = this.syncListeners.get(localUri)
    if (!listeners) {
      listeners = new Set()
      this.syncListeners.set(localUri, listeners)
    }
    listeners.add(listener)
    return () => {
      const current = this.syncListeners.get(localUri)
      if (!current) {
        return
      }
      current.delete(listener)
      if (current.size === 0) {
        this.syncListeners.delete(localUri)
      }
    }
  }

  async getSyncState(localUri: string): Promise<NotebookSyncState> {
    const record = await this.files.get(localUri)
    if (!record) {
      return {
        status: 'error',
        localUri,
        remoteId: '',
        lastError: `Local notebook record not found for ${localUri}`,
      }
    }

    if (this.inFlightSyncs.has(localUri)) {
      return syncStateForRecord(record, 'syncing')
    }

    if (record.conflict) {
      return syncStateForRecord(record, 'conflicted')
    }

    if (record.remoteId === '' && record.parentRemoteIdWhenCreated) {
      return syncStateForRecord(
        record,
        record.lastSyncError ? 'error' : 'pending-upstream-create'
      )
    }

    if (record.remoteId === '') {
      return syncStateForRecord(record, 'error', 'Missing upstream URI')
    }

    if (isLocalFileUpstream(record.remoteId, record.id)) {
      return syncStateForRecord(record, 'local-only')
    }

    if (record.lastSyncError) {
      return syncStateForRecord(record, 'error')
    }

    const localChecksum = await this.getOrBackfillLocalChecksum(
      localUri,
      record
    )
    const upstreamChecksum =
      detectNotebookFileFormat(record.name) === 'ipynb'
        ? (record.ipynbPreservation?.baselineNotebookChecksum ?? '')
        : (record.lastRemoteChecksum ?? '')
    return syncStateForRecord(
      { ...record, md5Checksum: localChecksum },
      localChecksum === upstreamChecksum ? 'synced' : 'pending'
    )
  }

  async listFileSyncStatuses(): Promise<NotebookSyncStatusRow[]> {
    const records = await this.files.toArray()
    const rows: NotebookSyncStatusRow[] = []

    for (const record of records) {
      const state = await this.getSyncState(record.id)
      const localRevision = await this.getOrBackfillLocalChecksum(
        record.id,
        record
      )
      const upstreamVersion = state.lastUpstreamVersion
      rows.push({
        localUri: record.id,
        title: record.name,
        googleDriveUrl: isDriveUri(state.remoteId) ? state.remoteId : '',
        revision: localRevision,
        upstreamRevision:
          upstreamVersion?.revisionId ??
          upstreamVersion?.checksum ??
          record.lastRemoteChecksum ??
          '',
        lastSynced: state.lastSynced,
        syncStatus: state.status,
        lastError: state.lastError,
      })
    }

    return rows
  }

  async getMetadata(uri: string): Promise<NotebookStoreItem | null> {
    if (!uri.startsWith('local://')) {
      throw new Error('getMetadata expects a local:// URI')
    }

    if (uri === LOCAL_FOLDER_URI) {
      const files = await this.files
        .filter((file) => isLocalFileUpstream(file.remoteId, file.id))
        .toArray()
      return {
        uri,
        name: 'Local Notebooks',
        type: NotebookStoreItemType.Folder,
        children: files.map((file) => file.id),
        remoteUri: undefined,
        parents: [],
      }
    }

    if (uri.startsWith('local://file/')) {
      const record = await this.files.get(uri)
      if (!record) {
        return null
      }
      const parentFolder = await this.findParentFolder(record.id)
      return {
        uri: record.id,
        name: record.name,
        mimeType: record.mimeType,
        type: NotebookStoreItemType.File,
        children: [],
        remoteUri: publicRemoteUri(record),
        parents: parentFolder ? [parentFolder.id] : [],
      }
    }

    if (uri.startsWith('local://folder/')) {
      const record = await this.folders.get(uri)
      if (!record) {
        return null
      }
      const parentFolder = await this.findParentFolder(record.id)
      return {
        uri: record.id,
        name: record.name,
        type: NotebookStoreItemType.Folder,
        children: [...record.children],
        remoteUri: publicRemoteUri(record),
        parents: parentFolder ? [parentFolder.id] : [],
      }
    }

    throw new Error(`Unsupported local URI format: ${uri}`)
  }

  /**
   * Persist a notebook into the local store. The caller provides a local URI
   * (e.g. `local://file/<uuid>`) that acts as the primary key for the record.
   */
  async save(uri: string, notebook: parser_pb.Notebook): Promise<void> {
    if (!uri.startsWith('local://file/')) {
      throw new Error(
        'LocalNotebooks.save expects a local://file/ URI; got ' + uri
      )
    }

    await this.persistNotebook(uri, notebook)
    const record = await this.files.get(uri)
    if (!record?.conflict) {
      this.enqueueSync(uri)
      this.enqueueMarkdownSync(uri)
    }
  }

  /** Create a tab-local snapshot adapter that appends .runme operations. */
  async createOperationLogSaveStore(
    uri: string,
    options: { actorId?: string } = {}
  ): Promise<{
    save(saveUri: string, notebook: parser_pb.Notebook): Promise<void>
  }> {
    const record = await this.files.get(uri)
    if (!record || !record.operationLogRef) {
      throw new Error(`Operation-log reference missing for ${uri}`)
    }
    if (detectNotebookFileFormat(record.name) !== 'runme-operation-log') {
      throw new Error(`Notebook ${uri} is not a .runme operation log`)
    }

    const initial = await this.operationLogStorage.read(record.operationLogRef)
    let view: ParsedOperationLog = parseOperationLog(initial.document)
    let previous = materializedLogToNotebook(
      materializeOperationLog(view.operations)
    )
    const actorId = options.actorId ?? (await getNotebookActorId(uri))
    let queue = Promise.resolve()

    return {
      save: async (saveUri: string, notebook: parser_pb.Notebook) => {
        if (saveUri !== uri) {
          throw new Error(
            `Operation-log save URI changed from ${uri} to ${saveUri}`
          )
        }
        const next = cloneNotebook(notebook)
        const operation = queue.then(async () => {
          let created: RunmeOperation[] = []
          const stored = await this.operationLogStorage.appendTransaction(
            record.operationLogRef!,
            async (currentDocument) => {
              const currentLog = parseOperationLog(currentDocument)
              if (currentLog.header.notebook_id !== view.header.notebook_id) {
                throw new Error(
                  `Operation-log notebook identity changed for ${uri}`
                )
              }
              created = await buildOperationLogDiff({
                previous,
                next,
                observedOperations: view.operations,
                actorId,
                firstActorSequence:
                  highestActorSequence(currentLog.operations, actorId) + 1,
              })
              return created.length === 0
                ? ''
                : `${created
                    .map((item) => canonicalJson(item as unknown as JsonValue))
                    .join('\n')}\n`
            },
            { validate: (document) => void parseOperationLog(document) }
          )
          if (created.length === 0) {
            previous = next
            return
          }
          view = {
            header: view.header,
            operations: [...view.operations, ...created],
          }
          previous = next
          await this.files.update(uri, {
            doc: '',
            md5Checksum: stored.checksum,
            operationLogRef: stored.ref,
          })
          this.notifySync(uri)
          if (!record.conflict) {
            this.enqueueSync(uri)
            this.enqueueMarkdownSync(uri)
          }
        })
        queue = operation.catch(() => undefined)
        await operation
      },
    }
  }

  operationLogSupportsConcurrentWriters(): boolean {
    return this.operationLogStorage.supportsConcurrentWriters()
  }

  async isOperationLogNotebook(uri: string): Promise<boolean> {
    const record = await this.files.get(uri)
    return (
      Boolean(record?.operationLogRef) &&
      detectNotebookFileFormat(record?.name ?? '') === 'runme-operation-log'
    )
  }

  async listOperationLogComments(uri: string): Promise<DriveComment[]> {
    const { parsed, materialized } =
      await this.readMaterializedOperationLog(uri)
    const operations = new Map(
      parsed.operations.map((operation) => [operation.op_id, operation])
    )
    const repliesByThread = new Map<string, DriveComment['replies']>()
    for (const comment of materialized.comments) {
      if (!comment.parent_comment_id) continue
      const replies = repliesByThread.get(comment.thread_id) ?? []
      const operation = operations.get(comment.operation_id)
      replies.push({
        id: comment.comment_id,
        content: comment.payload.body.value,
        createdTime: operation?.created_at,
        modifiedTime: operation?.created_at,
        author: {
          displayName: comment.payload.author.display_name,
          me: true,
        },
        runmeOperationId: comment.operation_id,
      })
      repliesByThread.set(comment.thread_id, replies)
    }
    return materialized.comments.flatMap((comment) => {
      if (comment.parent_comment_id) return []
      const operation = operations.get(comment.operation_id)
      const target = comment.payload.annotation.targets[0]
      const anchor =
        target &&
        typeof target === 'object' &&
        !Array.isArray(target) &&
        typeof target.anchor === 'string'
          ? target.anchor
          : undefined
      return [
        {
          id: comment.comment_id,
          content: comment.payload.body.value,
          createdTime: operation?.created_at,
          modifiedTime: operation?.created_at,
          resolved: materialized.threadStatus[comment.thread_id] === 'resolved',
          anchor,
          author: {
            displayName: comment.payload.author.display_name,
            me: true,
          },
          replies: repliesByThread.get(comment.thread_id) ?? [],
          runmeOperationId: comment.operation_id,
        },
      ]
    })
  }

  async addOperationLogComment(
    uri: string,
    input: {
      content: string
      anchor: string
      motivation?: CommentAddPayload['annotation']['motivation']
      actorId?: string
      commentId?: string
    }
  ): Promise<DriveComment> {
    const actorId = input.actorId ?? (await getNotebookActorId(uri))
    const commentId = input.commentId ?? crypto.randomUUID()
    const payload: CommentAddPayload = {
      comment_id: commentId,
      thread_id: commentId,
      author: { principal_id: actorId, display_name: 'This browser session' },
      body: { format: 'text/markdown', value: input.content },
      annotation: {
        motivation: input.motivation ?? 'commenting',
        targets: [{ anchor: input.anchor }],
      },
    }
    await this.appendOperationLogMutation(
      uri,
      'comment.add',
      payload as unknown as JsonValue,
      actorId
    )
    return (await this.listOperationLogComments(uri)).find(
      (comment) => comment.id === commentId
    )!
  }

  async replyToOperationLogComment(
    uri: string,
    parentCommentId: string,
    content: string,
    options: { actorId?: string } = {}
  ): Promise<DriveComment> {
    const { materialized } = await this.readMaterializedOperationLog(uri)
    const parent = materialized.comments.find(
      (comment) => comment.comment_id === parentCommentId
    )
    if (!parent) {
      throw new Error(`Operation-log comment ${parentCommentId} was not found`)
    }
    const actorId = options.actorId ?? (await getNotebookActorId(uri))
    const payload: CommentReplyPayload = {
      comment_id: crypto.randomUUID(),
      thread_id: parent.thread_id,
      parent_comment_id: parentCommentId,
      author: { principal_id: actorId, display_name: 'This browser session' },
      body: { format: 'text/markdown', value: content },
      annotation: { motivation: 'commenting', targets: [] },
    }
    await this.appendOperationLogMutation(
      uri,
      'comment.reply',
      payload as unknown as JsonValue,
      actorId
    )
    return (await this.listOperationLogComments(uri)).find(
      (comment) => comment.id === parent.thread_id
    )!
  }

  async setOperationLogCommentResolved(
    uri: string,
    commentId: string,
    resolved: boolean,
    options: { actorId?: string } = {}
  ): Promise<DriveComment> {
    const { materialized } = await this.readMaterializedOperationLog(uri)
    const comment = materialized.comments.find(
      (candidate) => candidate.comment_id === commentId
    )
    if (!comment) {
      throw new Error(`Operation-log comment ${commentId} was not found`)
    }
    await this.appendOperationLogMutation(
      uri,
      'thread.set_status',
      {
        thread_id: comment.thread_id,
        status: resolved ? 'resolved' : 'open',
      },
      options.actorId
    )
    return (await this.listOperationLogComments(uri)).find(
      (candidate) => candidate.id === comment.thread_id
    )!
  }

  private async readMaterializedOperationLog(uri: string) {
    const record = await this.files.get(uri)
    if (!record?.operationLogRef) {
      throw new Error(`Operation-log reference missing for ${uri}`)
    }
    const stored = await this.operationLogStorage.read(record.operationLogRef)
    const parsed = parseOperationLog(stored.document)
    return { parsed, materialized: materializeOperationLog(parsed.operations) }
  }

  private async appendOperationLogMutation(
    uri: string,
    kind: string,
    payload: JsonValue,
    suppliedActorId?: string
  ): Promise<void> {
    const record = await this.files.get(uri)
    if (!record?.operationLogRef) {
      throw new Error(`Operation-log reference missing for ${uri}`)
    }
    const actorId = suppliedActorId ?? (await getNotebookActorId(uri))
    const stored = await this.operationLogStorage.appendTransaction(
      record.operationLogRef,
      (currentDocument) => {
        const parsed = parseOperationLog(currentDocument)
        const operation = createRunmeOperation({
          actorId,
          actorSequence: highestActorSequence(parsed.operations, actorId) + 1,
          dependencies: causalHeads(parsed.operations),
          knownOperations: parsed.operations,
          kind,
          payload,
        })
        return `${canonicalJson(operation as unknown as JsonValue)}\n`
      },
      { validate: (document) => void parseOperationLog(document) }
    )
    await this.files.update(uri, {
      doc: '',
      md5Checksum: stored.checksum,
      operationLogRef: stored.ref,
    })
    this.notifySync(uri)
    if (!record.conflict) {
      this.enqueueSync(uri)
      this.enqueueMarkdownSync(uri)
    }
  }

  async loadContent(uri: string): Promise<string> {
    if (!uri.startsWith('local://file/')) {
      throw new Error(
        'LocalNotebooks.loadContent expects a local://file/ URI; got ' + uri
      )
    }

    const record = await this.files.get(uri)
    if (!record) {
      throw new Error(`Local file record not found for ${uri}`)
    }
    if (detectNotebookFileFormat(record.name) === 'runme-operation-log') {
      if (!record.operationLogRef) {
        throw new Error(`Operation-log reference missing for ${uri}`)
      }
      return (await this.operationLogStorage.read(record.operationLogRef))
        .document
    }
    if (detectNotebookFileFormat(record.name) === 'ipynb') {
      if (isLocalFileUpstream(record.remoteId, uri)) {
        const preservation = await this.refreshLocalIpynbShadow(uri, record)
        return this.ipynbShadowStorage.read(preservation.shadowRef)
      }
      if (record.ipynbPreservation) {
        return this.ipynbShadowStorage.read(record.ipynbPreservation.shadowRef)
      }
      if (isDriveUri(record.remoteId) && !record.doc) {
        const content = await this.driveStore.loadContent(record.remoteId)
        let upstreamVersion: UpstreamVersion = {}
        try {
          upstreamVersion = driveMetadataToUpstreamVersion(
            await this.driveStore.getVersionMetadata(record.remoteId)
          )
        } catch (error) {
          appLogger.warn(
            'Failed to record version metadata for uncached Drive ipynb',
            {
              attrs: {
                scope: 'storage.drive.sync',
                localUri: uri,
                remoteUri: record.remoteId,
                error: String(error),
              },
            }
          )
        }
        const upstreamFingerprint = upstreamVersion.checksum ?? md5(content)
        const decoded = await this.decodeUpstreamNotebook({
          localUri: uri,
          record,
          content,
          upstreamFingerprint,
        })
        await this.files.update(uri, {
          doc: decoded.serialized,
          md5Checksum: checksumForSerializedNotebook(decoded.serialized),
          lastRemoteChecksum: upstreamFingerprint,
          lastUpstreamVersion: upstreamVersion,
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
          ipynbPreservation: decoded.ipynbPreservation,
        })
        return content
      }
      const preservation = await this.refreshLocalIpynbShadow(uri, record)
      return this.ipynbShadowStorage.read(preservation.shadowRef)
    }
    if (record.doc || !isDriveUri(record.remoteId)) {
      return record.doc ?? ''
    }

    const content = await this.driveStore.loadContent(record.remoteId)
    let upstreamVersion: UpstreamVersion = {}
    try {
      upstreamVersion = driveMetadataToUpstreamVersion(
        await this.driveStore.getVersionMetadata(record.remoteId)
      )
    } catch (error) {
      appLogger.warn(
        'Failed to record version metadata for raw Drive content',
        {
          attrs: {
            scope: 'storage.drive.sync',
            localUri: uri,
            remoteUri: record.remoteId,
            error: String(error),
          },
        }
      )
    }
    await this.files.update(uri, {
      doc: content,
      md5Checksum: md5(content),
      lastRemoteChecksum: upstreamVersion.checksum ?? '',
      lastUpstreamVersion: upstreamVersion,
      lastSynced: nowIsoString(),
      lastSyncError: undefined,
    })
    return content
  }

  /** Materialize the current local .runme OPFS log without upstream I/O. */
  async loadOperationLogSnapshot(uri: string): Promise<parser_pb.Notebook> {
    if (!uri.startsWith('local://file/')) {
      throw new Error(
        'LocalNotebooks.loadOperationLogSnapshot expects a local://file/ URI; got ' +
          uri
      )
    }
    const record = await this.files.get(uri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${uri}`)
    }
    if (detectNotebookFileFormat(record.name) !== 'runme-operation-log') {
      throw new Error(`Notebook is not an operation log: ${uri}`)
    }
    if (!record.operationLogRef) {
      throw new Error(`Operation-log reference missing for ${uri}`)
    }
    const content = (
      await this.operationLogStorage.read(record.operationLogRef)
    ).document
    return decodeNotebookFile(content, record.name).notebook
  }

  async saveContent(
    uri: string,
    content: string,
    mimeType: string
  ): Promise<void> {
    if (!uri.startsWith('local://file/')) {
      throw new Error(
        'LocalNotebooks.saveContent expects a local://file/ URI; got ' + uri
      )
    }

    const record = await this.files.get(uri)
    if (!record) {
      throw new Error(`Local file record not found for ${uri}`)
    }

    const format = detectNotebookFileFormat(record.name)
    if (format === 'runme-operation-log') {
      const decoded = decodeNotebookFile(content, record.name)
      if (!decoded.operationLog) {
        throw new Error(`Expected operation-log content for ${record.name}`)
      }
      const stored = record.operationLogRef
        ? await this.operationLogStorage.replace(
            record.operationLogRef,
            content
          )
        : await this.operationLogStorage.initialize(uri, content)
      await this.files.update(uri, {
        doc: '',
        md5Checksum: stored.checksum,
        mimeType: RUNME_OPERATION_LOG_MIME_TYPE,
        operationLogRef: stored.ref,
      })
    } else if (format === 'ipynb') {
      const decoded = decodeNotebookFile(content, record.name)
      if (!decoded.ipynb) {
        throw new Error(`Expected ipynb content for ${record.name}`)
      }
      const serialized = serializeNotebook(decoded.notebook)
      const shadowRef = await this.ipynbShadowStorage.write(
        uri,
        decoded.ipynb.shadowText
      )
      const previousRef = record.ipynbPreservation?.shadowRef
      await this.files.update(uri, {
        doc: serialized,
        md5Checksum: checksumForSerializedNotebook(serialized),
        mimeType: IPYNB_MIME_TYPE,
        ipynbPreservation: {
          upstreamFingerprint: md5(content),
          baselineNotebookChecksum:
            record.ipynbPreservation?.baselineNotebookChecksum,
          shadowRef,
          jupyterIdByRunmeRefId: decoded.ipynb.jupyterIdByRunmeRefId,
          baselineCellHashes: decoded.ipynb.baselineCellHashes,
          baselineOutputHashes: decoded.ipynb.baselineOutputHashes,
        },
      })
      if (previousRef && previousRef.path !== shadowRef.path) {
        await this.ipynbShadowStorage.delete(previousRef).catch(() => {})
      }
    } else {
      const checksum = md5(content)
      await this.files.update(uri, {
        doc: content,
        md5Checksum: checksum,
        mimeType,
      })
    }
    this.notifySync(uri)
    if (!record.conflict) {
      this.enqueueSync(uri)
    }
  }

  async resolveConflictWithLocal(
    localUri: string,
    options: { force?: boolean } = {}
  ): Promise<void> {
    if (!localUri.startsWith('local://file/')) {
      throw new Error('resolveConflictWithLocal expects a local://file/ URI')
    }

    const record = await this.files.get(localUri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`)
    }
    if (!record.conflict) {
      throw new Error(`Local notebook ${localUri} does not have a conflict`)
    }
    if (!isDriveUri(record.remoteId)) {
      throw new Error(
        `Conflict resolution is only supported for Drive-backed notebooks; got ${record.remoteId}`
      )
    }

    const currentVersion = driveMetadataToUpstreamVersion(
      await this.driveStore.getVersionMetadata(record.remoteId)
    )
    const currentChecksum = currentVersion.checksum ?? ''
    if (
      currentChecksum &&
      currentChecksum !== record.conflict.upstreamChecksum &&
      !options.force
    ) {
      throw new NotebookConflictChangedError(
        localUri,
        record.conflict.upstreamChecksum,
        currentChecksum
      )
    }

    const localDoc =
      record.doc ||
      serializeNotebook(create(parser_pb.NotebookSchema, { cells: [] }))
    if (detectNotebookFileFormat(record.name) === 'ipynb') {
      await this.saveLocalDocToDrive(
        localUri,
        record.remoteId,
        localDoc,
        record.mimeType
      )
    } else {
      await this.driveStore.saveContent(
        record.remoteId,
        localDoc,
        NOTEBOOK_MIME_TYPE
      )
    }

    const updatedVersion = driveMetadataToUpstreamVersion(
      await this.driveStore.getVersionMetadata(record.remoteId)
    )
    const updatedChecksum =
      updatedVersion.checksum ?? checksumForSerializedNotebook(localDoc)
    const refreshedPreservation = (await this.files.get(localUri))
      ?.ipynbPreservation
    await this.files.update(localUri, {
      conflict: undefined,
      lastRemoteChecksum: updatedChecksum,
      lastUpstreamVersion: updatedVersion,
      md5Checksum: checksumForSerializedNotebook(localDoc),
      lastSynced: nowIsoString(),
      lastSyncError: undefined,
      ipynbPreservation: refreshedPreservation
        ? {
            ...refreshedPreservation,
            upstreamFingerprint: updatedChecksum,
          }
        : undefined,
    })
    await this.deleteConflictDoc(record.conflict)
    this.notifySync(localUri)
  }

  async refreshConflictWithLatestUpstream(
    localUri: string
  ): Promise<NotebookConflictState> {
    if (!localUri.startsWith('local://file/')) {
      throw new Error(
        'refreshConflictWithLatestUpstream expects a local://file/ URI'
      )
    }

    const record = await this.files.get(localUri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`)
    }
    if (!record.conflict) {
      throw new Error(`Local notebook ${localUri} does not have a conflict`)
    }
    if (!isDriveUri(record.remoteId)) {
      throw new Error(
        `Conflict refresh is only supported for Drive-backed notebooks; got ${record.remoteId}`
      )
    }

    const upstreamVersion = driveMetadataToUpstreamVersion(
      await this.driveStore.getVersionMetadata(record.remoteId)
    )
    const upstream = await this.loadDriveNotebookDocument(
      localUri,
      record,
      upstreamVersion.checksum ?? ''
    )
    const upstreamDoc = upstream.serialized
    const upstreamChecksum =
      upstreamVersion.checksum ?? checksumForSerializedNotebook(upstreamDoc)
    const localChecksum = await this.getOrBackfillLocalChecksum(
      localUri,
      record
    )
    const conflict = await this.createConflictState({
      localUri,
      upstreamDoc,
      upstreamChecksum,
      upstreamVersion,
      localChecksumAtDetection: localChecksum,
    })

    await this.files.update(localUri, {
      conflict,
      lastSyncError: undefined,
    })
    this.notifySync(localUri)
    return conflict
  }

  async getConflictUpstreamDoc(localUri: string): Promise<string> {
    const record = await this.files.get(localUri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`)
    }
    const conflict = record.conflict
    if (!conflict) {
      throw new Error(`Local notebook ${localUri} does not have a conflict`)
    }

    if (conflict.upstreamDocRef) {
      return this.getConflictDocStorage().read(conflict.upstreamDocRef)
    }

    if (typeof conflict.upstreamDoc === 'string') {
      const legacyDoc = conflict.upstreamDoc
      const migrated = await this.createConflictState({
        localUri,
        upstreamDoc: legacyDoc,
        upstreamChecksum: conflict.upstreamChecksum,
        upstreamVersion: conflict.upstreamVersion,
        localChecksumAtDetection: conflict.localChecksumAtDetection,
        detectedAt: conflict.detectedAt,
      })
      await this.files.update(localUri, { conflict: migrated })
      return legacyDoc
    }

    throw new Error(
      `Conflict upstream document is missing for local notebook ${localUri}`
    )
  }

  async getDriveUpstreamDoc(
    localUri: string
  ): Promise<{ doc: string; version?: UpstreamVersion }> {
    const record = await this.files.get(localUri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`)
    }
    if (!isDriveUri(record.remoteId)) {
      throw new Error(
        `Drive upstream loading is only supported for Drive-backed notebooks; got ${record.remoteId}`
      )
    }
    if (record.conflict) {
      return {
        doc: await this.getConflictUpstreamDoc(localUri),
        version: record.conflict.upstreamVersion,
      }
    }

    const upstreamVersion = driveMetadataToUpstreamVersion(
      await this.driveStore.getVersionMetadata(record.remoteId)
    )
    const upstream = await this.loadDriveNotebookDocument(
      localUri,
      record,
      upstreamVersion.checksum ?? ''
    )
    return {
      doc: upstream.serialized,
      version: upstreamVersion,
    }
  }

  async listDriveRevisions(localUri: string): Promise<DriveRevision[]> {
    const record = await this.files.get(localUri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`)
    }
    if (!isDriveUri(record.remoteId)) {
      throw new Error(
        `Drive revisions are only supported for Drive-backed notebooks; got ${record.remoteId}`
      )
    }
    return this.driveStore.listRevisions(record.remoteId)
  }

  async getDriveRevisionDoc(
    localUri: string,
    revisionId: string
  ): Promise<string> {
    const normalizedRevisionId = revisionId.trim()
    if (!normalizedRevisionId) {
      throw new Error('getDriveRevisionDoc requires a revision id')
    }
    const record = await this.files.get(localUri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`)
    }
    if (!isDriveUri(record.remoteId)) {
      throw new Error(
        `Drive revision loading is only supported for Drive-backed notebooks; got ${record.remoteId}`
      )
    }

    try {
      return await this.getRevisionDocStorage().read(
        localUri,
        normalizedRevisionId
      )
    } catch {
      // Revisions are immutable, so a cache miss can be repaired by fetching
      // the exact Drive revision and storing it in OPFS for future diffs.
    }

    const revisionDoc = serializeNotebook(
      await this.driveStore.loadRevision(
        record.remoteId,
        normalizedRevisionId,
        record.name
      )
    )
    await this.getRevisionDocStorage().write(
      localUri,
      normalizedRevisionId,
      revisionDoc
    )
    return this.getRevisionDocStorage().read(localUri, normalizedRevisionId)
  }

  private async persistNotebook(
    uri: string,
    notebook: parser_pb.Notebook
  ): Promise<void> {
    const record = await this.files.get(uri)
    if (!record) {
      throw new Error(
        `Local notebook record not found for ${uri}. Call addFile first.`
      )
    }
    if (detectNotebookFileFormat(record.name) === 'runme-operation-log') {
      throw new Error(
        'Runme operation-log notebooks must persist mutations through their journal'
      )
    }

    migrateNotebookCellIds(notebook)
    const serialized = serializeNotebook(notebook)
    const checksum = checksumForSerializedNotebook(serialized)

    await this.files.update(uri, { doc: serialized, md5Checksum: checksum })
    this.notifySync(uri)
  }

  async load(uri: string): Promise<parser_pb.Notebook> {
    if (!uri.startsWith('local://file/')) {
      throw new Error(
        'LocalNotebooks.load expects a local://file/ URI; got ' + uri
      )
    }

    const existing = await this.files.get(uri)
    if (!existing) {
      throw new Error(
        `Local notebook record not found for ${uri}; call addFile first.`
      )
    }

    const shouldSync = needsSync(existing.lastSynced, 8 * 60 * 60 * 1000)

    let record = existing
    if (shouldSync) {
      // Best-effort attempt to ensure the local cache reflects the latest remote state
      // before we hydrate the notebook for the caller.
      try {
        await this.syncFile(uri)
      } catch (error) {
        appLogger.warn(
          'Continuing with local notebook after sync-on-load failed',
          {
            attrs: {
              scope: 'storage.local.sync',
              localUri: uri,
              error: String(error),
            },
          }
        )
      }

      const refreshed = await this.files.get(uri)
      if (!refreshed) {
        throw new Error(`Local notebook record missing for ${uri} after sync.`)
      }
      record = refreshed
    }

    if (detectNotebookFileFormat(record.name) === 'runme-operation-log') {
      return this.loadOperationLogSnapshot(uri)
    }

    if (!record.doc) {
      return create(parser_pb.NotebookSchema, { cells: [] })
    }

    try {
      const notebook = fromJsonString(parser_pb.NotebookSchema, record.doc, {
        ignoreUnknownFields: true,
      })
      migrateNotebookCellIds(
        notebook,
        detectNotebookFileFormat(record.name) === 'ipynb'
          ? record.ipynbPreservation?.jupyterIdByRunmeRefId
          : undefined
      )
      return notebook
    } catch (error) {
      console.error('Failed to parse notebook from local store', error)
      return create(parser_pb.NotebookSchema, { cells: [] })
    }
  }

  async create(parentUri: string, name: string): Promise<NotebookStoreItem> {
    const format = detectNotebookFileFormat(name)
    return this.createLocalFile(parentUri, name, {
      mimeType:
        format === 'ipynb'
          ? IPYNB_MIME_TYPE
          : format === 'runme-operation-log'
            ? RUNME_OPERATION_LOG_MIME_TYPE
            : NOTEBOOK_MIME_TYPE,
      content: '',
    })
  }

  async createContent(
    parentUri: string,
    name: string,
    content: string,
    mimeType: string,
    options: {
      legacyConversionAttempt?: LocalFileRecord['legacyConversionAttempt']
    } = {}
  ): Promise<NotebookStoreItem> {
    return this.createLocalFile(parentUri, name, {
      mimeType,
      content,
      legacyConversionAttempt: options.legacyConversionAttempt,
    })
  }

  /**
   * Create a sibling .runme copy of a legacy .json or .ipynb notebook.
   * Drive-backed sources produce a new Drive file and retain the source Drive
   * file ID in notebook metadata. Comments remain attached to the source file.
   */
  async convertLegacyNotebookToRunme(
    sourceUri: string,
    parentUri?: string
  ): Promise<NotebookStoreItem> {
    if (!sourceUri.startsWith('local://file/')) {
      throw new Error(
        'LocalNotebooks.convertLegacyNotebookToRunme expects a local file URI'
      )
    }
    let sourceRecord = await this.files.get(sourceUri)
    if (!sourceRecord) {
      throw new Error(`Local notebook record not found for ${sourceUri}`)
    }
    const sourceFormat = detectNotebookFileFormat(sourceRecord.name)
    if (sourceFormat !== 'runme-json' && sourceFormat !== 'ipynb') {
      throw new Error('Only .json and .ipynb notebooks can be converted')
    }

    if (
      isDriveUri(sourceRecord.remoteId) ||
      isDriveUri(sourceRecord.parentRemoteIdWhenCreated)
    ) {
      await this.syncFile(sourceUri)
      sourceRecord = await this.files.get(sourceUri)
      if (!sourceRecord) {
        throw new Error(`Local notebook record not found for ${sourceUri}`)
      }
      if (!isDriveUri(sourceRecord.remoteId)) {
        throw new Error(
          `Google Drive source did not receive a remote ID after sync: ${sourceUri}`
        )
      }
    }
    const sourceContent = await this.loadContent(sourceUri)
    const originalGoogleDriveId = isDriveUri(sourceRecord.remoteId)
      ? parseDriveItem(sourceRecord.remoteId).id
      : undefined
    const converted = await convertLegacyNotebookFileToRunme(
      sourceContent,
      sourceRecord.name,
      { originalGoogleDriveId }
    )
    const sourceChecksum = md5(sourceContent)

    let destinationParentUri = parentUri
    if (!destinationParentUri) {
      destinationParentUri = (await this.findParentFolder(sourceUri))?.id
    }
    if (!destinationParentUri && isDriveUri(sourceRecord.remoteId)) {
      const sourceMetadata = await this.driveStore.getMetadata(
        sourceRecord.remoteId
      )
      const remoteParentUri = sourceMetadata?.parents?.[0]
      if (!remoteParentUri) {
        throw new Error(
          `Google Drive parent folder not found for ${sourceRecord.remoteId}`
        )
      }
      destinationParentUri = await this.updateFolder(remoteParentUri)
    }
    if (!destinationParentUri) {
      destinationParentUri = LOCAL_FOLDER_URI
    }
    const destinationParent = await this.folders.get(destinationParentUri)
    if (!destinationParent) {
      throw new Error(`Parent folder not found for ${destinationParentUri}`)
    }

    if (isDriveUri(destinationParent.remoteId) && originalGoogleDriveId) {
      for (const childUri of destinationParent.children) {
        if (!childUri.startsWith('local://file/')) {
          continue
        }
        const child = await this.files.get(childUri)
        const isPendingCreate =
          child?.remoteId === '' &&
          child.parentRemoteIdWhenCreated === destinationParent.remoteId
        const isErroredDriveConversion =
          isDriveUri(child?.remoteId) && Boolean(child?.lastSyncError)
        if (
          child?.name !== converted.fileName ||
          (!isPendingCreate && !isErroredDriveConversion) ||
          child.legacyConversionAttempt?.originalGoogleDriveId !==
            originalGoogleDriveId ||
          detectNotebookFileFormat(child.name) !== 'runme-operation-log'
        ) {
          continue
        }
        try {
          const pendingNotebook = await this.loadOperationLogSnapshot(childUri)
          if (
            pendingNotebook.metadata[RunmeMetadataKey.OriginalGoogleDriveID] !==
            originalGoogleDriveId
          ) {
            continue
          }
        } catch {
          continue
        }

        if (child.legacyConversionAttempt.sourceChecksum !== sourceChecksum) {
          const currentLog = parseOperationLog(
            await this.loadContent(childUri)
          )
          const refreshedContent =
            await encodeRunmeOperationLogSnapshotWithHeader(
              converted.notebook,
              currentLog.header
            )
          await this.saveContent(
            childUri,
            refreshedContent,
            RUNME_OPERATION_LOG_MIME_TYPE
          )
          await this.files.update(childUri, {
            legacyConversionAttempt: {
              originalGoogleDriveId,
              sourceChecksum,
            },
          })
        }

        await this.syncFile(childUri)
        await this.files.update(childUri, {
          legacyConversionAttempt: undefined,
        })
        return (
          (await this.getMetadata(childUri)) ?? {
            uri: childUri,
            name: child.name,
            type: NotebookStoreItemType.File,
            children: [],
            remoteUri: publicRemoteUri(child),
            mimeType: child.mimeType,
            parents: [destinationParentUri],
          }
        )
      }
    }

    const created = await this.createContent(
      destinationParentUri,
      converted.fileName,
      converted.content,
      RUNME_OPERATION_LOG_MIME_TYPE,
      {
        legacyConversionAttempt:
          isDriveUri(destinationParent.remoteId) && originalGoogleDriveId
            ? { originalGoogleDriveId, sourceChecksum }
            : undefined,
      }
    )
    if (isDriveUri(destinationParent.remoteId)) {
      await this.syncFile(created.uri)
      await this.files.update(created.uri, {
        legacyConversionAttempt: undefined,
      })
    }
    return (await this.getMetadata(created.uri)) ?? created
  }

  private async createLocalFile(
    parentUri: string,
    name: string,
    options: {
      mimeType: string
      content: string
      legacyConversionAttempt?: LocalFileRecord['legacyConversionAttempt']
    }
  ): Promise<NotebookStoreItem> {
    if (!parentUri.startsWith('local://folder/')) {
      throw new Error('LocalNotebooks.create expects a folder parent URI')
    }

    const parent = await this.folders.get(parentUri)
    if (!parent) {
      throw new Error(`Parent folder not found for ${parentUri}`)
    }

    const fileUri = this.generateLocalUri('file')
    const isDriveBackedParent = isDriveUri(parent.remoteId)
    let localContent = options.content
    let ipynbPreservation: IpynbPreservationState | undefined
    let operationLogRef: OperationLogRef | undefined
    const format = detectNotebookFileFormat(name)
    if (format === 'runme-operation-log') {
      const initialLog = options.content || createInitialNotebookFile(name)
      decodeNotebookFile(initialLog, name)
      const stored = await this.operationLogStorage.initialize(
        fileUri,
        initialLog
      )
      localContent = ''
      operationLogRef = stored.ref
    } else if (format === 'ipynb') {
      const initialIpynb = options.content || createInitialNotebookFile(name)
      const decoded = decodeNotebookFile(initialIpynb, name)
      localContent = serializeNotebook(decoded.notebook)
      const shadowRef = await this.ipynbShadowStorage.write(
        fileUri,
        decoded.ipynb?.shadowText ?? initialIpynb
      )
      ipynbPreservation = {
        upstreamFingerprint: '',
        baselineNotebookChecksum: checksumForSerializedNotebook(localContent),
        shadowRef,
        jupyterIdByRunmeRefId: decoded.ipynb?.jupyterIdByRunmeRefId ?? {},
        baselineCellHashes: decoded.ipynb?.baselineCellHashes ?? {},
        baselineOutputHashes: decoded.ipynb?.baselineOutputHashes ?? {},
      }
    }
    const operationLogChecksum = operationLogRef
      ? (await this.operationLogStorage.read(operationLogRef)).checksum
      : undefined
    const checksum =
      operationLogChecksum ?? (localContent ? md5(localContent) : '')
    const record: LocalFileRecord = {
      id: fileUri,
      name,
      mimeType: options.mimeType,
      remoteId: isDriveBackedParent ? '' : fileUri,
      parentRemoteIdWhenCreated: isDriveBackedParent
        ? parent.remoteId
        : undefined,
      driveCreateOperationId: isDriveBackedParent ? uuidv4() : undefined,
      legacyConversionAttempt: options.legacyConversionAttempt,
      lastRemoteChecksum: '',
      lastSynced: isDriveBackedParent ? '' : nowIsoString(),
      doc: localContent,
      md5Checksum: checksum,
      ipynbPreservation,
      operationLogRef,
    }
    await this.files.put(record)

    await this.mutateFolderChildren(parentUri, (children) =>
      children.includes(fileUri) ? children : [...children, fileUri]
    )

    if (canDispatchWindowEvents()) {
      window.dispatchEvent(
        new CustomEvent('local-notebook-updated', {
          detail: { uri: fileUri, name, remoteUri: undefined },
        })
      )
    }

    if (isDriveBackedParent) {
      void (async () => {
        try {
          await this.syncFile(fileUri)
        } catch (error) {
          appLogger.warn('Pending Drive notebook creation did not complete', {
            attrs: {
              scope: 'storage.drive.sync',
              localUri: fileUri,
              parentRemoteUri: parent.remoteId,
              error: String(error),
            },
          })
        }
      })()
    }

    return {
      uri: fileUri,
      name,
      type: NotebookStoreItemType.File,
      children: [],
      remoteUri: undefined,
      mimeType: options.mimeType,
      parents: [parentUri],
    }
  }

  async createFolder(
    parentUri: string,
    name: string
  ): Promise<NotebookStoreItem> {
    if (!parentUri.startsWith('local://folder/')) {
      throw new Error('LocalNotebooks.createFolder expects a folder parent URI')
    }

    const parent = await this.folders.get(parentUri)
    if (!parent) {
      throw new Error(`Parent folder not found for ${parentUri}`)
    }
    if (!isDriveUri(parent.remoteId)) {
      throw new Error(
        'LocalNotebooks.createFolder expects a Drive-backed parent'
      )
    }

    const trimmedName = name.trim() || 'New Folder'
    const remoteFolder = await this.driveStore.createFolder(
      parent.remoteId,
      trimmedName
    )
    const remoteUri = remoteFolder.remoteUri ?? remoteFolder.uri
    const existingFolder = await this.folders
      .where('remoteId')
      .equals(remoteUri)
      .first()
    const folderUri = existingFolder?.id ?? this.generateLocalUri('folder')
    const folderRecord: LocalFolderRecord = {
      id: folderUri,
      name: remoteFolder.name || trimmedName,
      remoteId: remoteUri,
      children: existingFolder?.children ?? [],
      lastSynced: nowIsoString(),
    }

    await this.folders.put(folderRecord)
    await this.mutateFolderChildren(parentUri, (children) =>
      children.includes(folderUri) ? children : [...children, folderUri]
    )

    if (canDispatchWindowEvents()) {
      window.dispatchEvent(
        new CustomEvent('local-notebook-updated', {
          detail: {
            uri: folderUri,
            name: folderRecord.name,
            remoteUri,
          },
        })
      )
    }

    return {
      uri: folderUri,
      name: folderRecord.name,
      type: NotebookStoreItemType.Folder,
      children: [],
      remoteUri,
      parents: [parentUri],
    }
  }

  /**
   * Rename a local mirror and, when known, its upstream Drive item first.
   *
   * `remoteUriOverride` lets callers that already resolved the visible Drive
   * item preserve that upstream identity when an older or partially repaired
   * local mirror has stale `remoteId` metadata. The override is accepted only
   * for a canonical Drive item URI; local-only renames remain local-only.
   */
  async rename(
    uri: string,
    name: string,
    remoteUriOverride?: string
  ): Promise<NotebookStoreItem> {
    if (uri.startsWith('local://folder/')) {
      const record = await this.folders.get(uri)
      if (!record) {
        throw new Error(`Local folder record not found for ${uri}`)
      }

      let nextName = name
      let nextRemoteId = record.remoteId

      const remoteUri = isDriveUri(remoteUriOverride)
        ? remoteUriOverride
        : isDriveUri(record.remoteId)
          ? record.remoteId
          : undefined

      appLogger.info('Resolved folder rename destination', {
        attrs: {
          scope: 'storage.rename',
          code: 'LOCAL_FOLDER_RENAME_DESTINATION_RESOLVED',
          uri,
          recordRemoteUri: record.remoteId,
          remoteUriOverride,
          remoteUri,
        },
      })

      if (remoteUri) {
        const remoteItem = await this.driveStore.rename(remoteUri, name)
        nextName = remoteItem.name || name
        nextRemoteId = remoteItem.remoteUri ?? remoteItem.uri ?? record.remoteId
      }

      await this.folders.update(uri, {
        name: nextName,
        remoteId: nextRemoteId,
      })

      const parentFolder = await this.findParentFolder(uri)

      if (canDispatchWindowEvents()) {
        window.dispatchEvent(
          new CustomEvent('local-notebook-updated', {
            detail: {
              uri,
              name: nextName,
              remoteUri: publicRemoteUri({
                ...record,
                remoteId: nextRemoteId,
              }),
            },
          })
        )
      }

      const updatedRecord = {
        ...record,
        name: nextName,
        remoteId: nextRemoteId,
      }

      return {
        uri,
        name: nextName,
        type: NotebookStoreItemType.Folder,
        children: [...record.children],
        remoteUri: publicRemoteUri(updatedRecord),
        parents: parentFolder ? [parentFolder.id] : [],
      }
    }

    if (!uri.startsWith('local://file/')) {
      throw new Error('LocalNotebooks.rename expects a file or folder URI')
    }

    const record = await this.files.get(uri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${uri}`)
    }

    const currentFormat = detectNotebookFileFormat(record.name)
    const requestedFormat = detectNotebookFileFormat(name)
    validateNotebookRenameFormat(record.name, name)
    let nextName =
      currentFormat && !requestedFormat
        ? `${name.trim()}${notebookFileExtension(currentFormat)}`
        : name
    let nextRemoteId = record.remoteId

    const remoteUri = isDriveUri(remoteUriOverride)
      ? remoteUriOverride
      : isDriveUri(record.remoteId)
        ? record.remoteId
        : undefined

    appLogger.info('Resolved notebook rename destination', {
      attrs: {
        scope: 'storage.rename',
        code: 'LOCAL_FILE_RENAME_DESTINATION_RESOLVED',
        uri,
        recordRemoteUri: record.remoteId,
        remoteUriOverride,
        remoteUri,
        requestedName: nextName,
      },
    })

    if (remoteUri) {
      const remoteItem = await this.driveStore.rename(remoteUri, nextName)
      nextName = remoteItem.name || nextName
      nextRemoteId = remoteItem.remoteUri ?? remoteItem.uri ?? record.remoteId
    }

    await this.files.update(uri, { name: nextName, remoteId: nextRemoteId })

    const parentFolder = await this.findParentFolder(uri)

    if (canDispatchWindowEvents()) {
      window.dispatchEvent(
        new CustomEvent('local-notebook-updated', {
          detail: {
            uri,
            name: nextName,
            remoteUri: publicRemoteUri({ ...record, remoteId: nextRemoteId }),
          },
        })
      )
    }

    return {
      uri,
      name: nextName,
      type: NotebookStoreItemType.File,
      children: [],
      remoteUri: publicRemoteUri({ ...record, remoteId: nextRemoteId }),
      parents: parentFolder ? [parentFolder.id] : [],
    }
  }

  async move(
    uri: string,
    destinationFolderUri: string
  ): Promise<NotebookStoreItem> {
    const sourceParent = await this.findParentFolder(uri)
    const destinationFolder = await this.folders.get(destinationFolderUri)
    if (!sourceParent) {
      throw new Error(`Local parent folder not found for ${uri}`)
    }
    if (!destinationFolder) {
      throw new Error(
        `Local destination folder not found for ${destinationFolderUri}`
      )
    }
    if (
      !isDriveUri(sourceParent.remoteId) ||
      !isDriveUri(destinationFolder.remoteId)
    ) {
      throw new Error('LocalNotebooks.move only supports Drive-backed folders')
    }
    if (sourceParent.id === destinationFolder.id) {
      throw new Error('LocalNotebooks.move expects a new destination folder')
    }

    const file = uri.startsWith('local://file/')
      ? await this.files.get(uri)
      : null
    const folder = uri.startsWith('local://folder/')
      ? await this.folders.get(uri)
      : null
    const item = file ?? folder
    if (!item) {
      throw new Error(`Local Drive-backed item not found for ${uri}`)
    }
    if (!isDriveUri(item.remoteId)) {
      throw new Error('LocalNotebooks.move expects a Drive-backed item')
    }
    if (folder) {
      let ancestor: LocalFolderRecord | null = destinationFolder
      while (ancestor) {
        if (ancestor.id === folder.id) {
          throw new Error(
            'LocalNotebooks.move cannot move a folder into itself or a descendant'
          )
        }
        ancestor = await this.findParentFolder(ancestor.id)
      }
    }

    await this.driveStore.move(
      item.remoteId,
      sourceParent.remoteId,
      destinationFolder.remoteId
    )

    let clearMarkdownUri = false
    if (file?.markdownUri) {
      if (isDriveUri(file.markdownUri)) {
        try {
          await this.driveStore.move(
            file.markdownUri,
            sourceParent.remoteId,
            destinationFolder.remoteId
          )
        } catch (error) {
          clearMarkdownUri = true
          appLogger.warn(
            'Failed to move notebook markdown sidecar; it will be recreated after the notebook move',
            {
              attrs: {
                scope: 'storage.drive.move',
                code: 'DRIVE_MARKDOWN_SIDECAR_MOVE_FAILED',
                localUri: uri,
                markdownUri: file.markdownUri,
                error: String(error),
              },
            }
          )
        }
      } else {
        clearMarkdownUri = true
      }
    }
    if (clearMarkdownUri) {
      await this.files.update(uri, { markdownUri: undefined })
    }

    await this.mutateFolderChildren(sourceParent.id, (children) =>
      children.filter((childUri) => childUri !== uri)
    )
    await this.mutateFolderChildren(destinationFolder.id, (children) =>
      children.includes(uri) ? children : [...children, uri]
    )

    if (clearMarkdownUri && file) {
      try {
        await this.syncMarkdownFile(uri)
      } catch (error) {
        appLogger.warn(
          'Failed to recreate notebook markdown sidecar after move',
          {
            attrs: {
              scope: 'storage.drive.move',
              code: 'DRIVE_MARKDOWN_SIDECAR_RECREATE_FAILED',
              localUri: uri,
              error: String(error),
            },
          }
        )
      }
    }

    return {
      uri,
      name: item.name,
      type: file ? NotebookStoreItemType.File : NotebookStoreItemType.Folder,
      children: folder ? [...folder.children] : [],
      remoteUri: item.remoteId,
      mimeType: file?.mimeType,
      parents: [destinationFolderUri],
    }
  }

  async moveToTrash(uri: string): Promise<void> {
    if (!uri.startsWith('local://file/')) {
      throw new Error('LocalNotebooks.moveToTrash expects a file URI')
    }

    const record = await this.files.get(uri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${uri}`)
    }
    if (!isDriveUri(record.remoteId)) {
      throw new Error('LocalNotebooks.moveToTrash expects a Drive-backed file')
    }

    await this.driveStore.moveToTrash(record.remoteId)

    const parentFolder = await this.findParentFolder(uri)
    if (parentFolder) {
      await this.mutateFolderChildren(parentFolder.id, (children) =>
        children.filter((childUri) => childUri !== uri)
      )
    }
    await this.deleteConflictDoc(record.conflict)
    await this.files.delete(uri)
    if (record.operationLogRef) {
      await this.operationLogStorage
        .delete(record.operationLogRef)
        .catch((error) => {
          appLogger.warn('Failed to delete trashed operation log from OPFS', {
            attrs: {
              scope: 'storage.local.operation-log',
              localUri: uri,
              error: String(error),
            },
          })
        })
    }
    if (record.ipynbPreservation) {
      await this.ipynbShadowStorage
        .delete(record.ipynbPreservation.shadowRef)
        .catch(() => {})
    }
  }

  /**
   * Ensure a Markdown sidecar file exists and is synced to Drive for the given file.
   * The purpose of the sidecar file is to make the content available to company knowledge for
   * indexing to make it available to ChatGPT.
   * This is a best-effort helper and does nothing for files that are not backed
   * by Google Drive.
   */
  async syncMarkdownFile(localUri: string): Promise<void> {
    if (!localUri.startsWith('local://file/')) {
      throw new Error('syncMarkdownFile expects a local://file/ URI')
    }

    await this.driveSyncCoordinator.runExclusive(localUri, () =>
      this.syncMarkdownFileInner(localUri)
    )
  }

  private async syncMarkdownFileInner(localUri: string): Promise<void> {
    const record = await this.files.get(localUri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`)
    }

    // Only Drive-backed files need a Markdown sidecar.
    if (!isDriveUri(record.remoteId)) {
      return
    }

    const driveStore = appState.driveNotebookStore ?? this.driveStore
    if (!driveStore) {
      console.error('No DriveNotebookStore available for syncing markdown')
      return
    }

    let markdownUri = record.markdownUri

    if (!markdownUri) {
      const metadata = await driveStore.getMetadata(record.remoteId)
      const parentUri = metadata?.parents?.[0]
      const name = metadata?.name ?? 'notebook'

      if (!parentUri) {
        console.warn('Cannot create markdown sidecar without parent folder', {
          remoteId: record.remoteId,
        })
        return
      }

      const baseName = name.replace(/\.[^.]+$/, '')
      const markdownName = `${baseName}.index.md`
      const createOperationId = record.markdownCreateOperationId ?? uuidv4()
      if (!record.markdownCreateOperationId) {
        await this.files.update(localUri, {
          markdownCreateOperationId: createOperationId,
        })
      }
      const existingFile = await driveStore.findByCreateOperation(
        parentUri,
        createOperationId
      )
      const markdownFile =
        existingFile ??
        (await driveStore.create(parentUri, markdownName, {
          createOperationId,
        }))
      markdownUri = markdownFile.uri
      await this.files.update(localUri, { markdownUri })
    }

    let markdownContent: string
    try {
      const notebook =
        detectNotebookFileFormat(record.name) === 'runme-operation-log'
          ? decodeNotebookFile(
              (await this.operationLogStorage.read(record.operationLogRef!))
                .document,
              record.name
            ).notebook
          : deserializeNotebook(record.doc ?? '')
      markdownContent = serializeNotebookToMarkdown(notebook)
    } catch (error) {
      console.error('Failed to serialize notebook to markdown', error)
      return
    }

    try {
      await driveStore.saveContent(
        markdownUri,
        markdownContent,
        'text/markdown'
      )
    } catch (error) {
      console.error('Failed to upload markdown sidecar to Drive', error)
    }
  }

  /**
   * Generate a stable local URI for a file or folder using a random UUID.
   */
  private generateLocalUri(type: 'file' | 'folder'): string {
    const uuid = uuidv4()
    return `local://${type}/${uuid}`
  }

  /**
   * Return local URIs for Drive-backed files that currently have unapplied
   * local changes relative to the last known upstream notebook baseline. Raw
   * IPYNB fingerprints and decoded notebook checksums use different domains,
   * so IPYNB records compare against their decoded preservation baseline.
   *
   * For migrated records where `md5Checksum` is missing/empty but `doc` exists,
   * this method computes and persists the checksum lazily.
   */
  async listDriveBackedFilesNeedingSync(): Promise<string[]> {
    const driveBackedFiles = await this.files
      .filter(
        (record) =>
          isDriveUri(record.remoteId) ||
          Boolean(record.parentRemoteIdWhenCreated)
      )
      .toArray()
    const pending: string[] = []

    for (const record of driveBackedFiles) {
      if (record.conflict) {
        continue
      }
      if (record.remoteId === '' && record.parentRemoteIdWhenCreated) {
        pending.push(record.id)
        continue
      }
      const localChecksum = await this.getOrBackfillLocalChecksum(
        record.id,
        record
      )
      const upstreamNotebookChecksum =
        detectNotebookFileFormat(record.name) === 'ipynb'
          ? (record.ipynbPreservation?.baselineNotebookChecksum ?? '')
          : (record.lastRemoteChecksum ?? '')
      if (localChecksum !== upstreamNotebookChecksum) {
        pending.push(record.id)
      }
    }

    return pending
  }

  /**
   * Enqueue sync for every Drive-backed file that appears locally modified.
   * Returns the list of enqueued local URIs.
   */
  async enqueueDriveBackedFilesNeedingSync(): Promise<string[]> {
    const pending = await this.listDriveBackedFilesNeedingSync()
    appLogger.info('Drive resync reconciliation evaluated pending files', {
      attrs: {
        scope: 'storage.drive.sync',
        code: 'DRIVE_RESYNC_EVALUATED',
        pendingCount: pending.length,
        localUris: pending,
      },
    })
    for (const uri of pending) {
      appLogger.info('Requeued Drive-backed notebook for sync', {
        attrs: {
          scope: 'storage.drive.sync',
          code: 'DRIVE_RESYNC_REQUEUED_FILE',
          localUri: uri,
        },
      })
      this.enqueueSync(uri)
      this.enqueueMarkdownSync(uri)
    }
    return pending
  }

  private enqueueSync(uri: string): void {
    let subject = this.syncSubjects.get(uri)
    if (!subject) {
      subject = new Subject<void>()
      const DEBOUNCE_TIME_MS = 20 * 1000 // 20 seconds
      subject.pipe(debounceTime(DEBOUNCE_TIME_MS)).subscribe(async () => {
        try {
          await this.syncFile(uri)
        } catch (error) {
          console.error('Failed to synchronise notebook', uri, error)
        }
      })
      this.syncSubjects.set(uri, subject)
    }
    subject.next()
  }

  private notifySync(uri: string): void {
    const listeners = this.syncListeners.get(uri)
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          console.error('Local notebook sync listener failed', error)
        }
      }
    }
    if (canDispatchWindowEvents()) {
      window.dispatchEvent(
        new CustomEvent('local-notebook-sync-updated', {
          detail: { uri },
        })
      )
    }
  }

  private enqueueMarkdownSync(uri: string): void {
    let mdSubject = this.markdownSyncSubjects.get(uri)
    if (!mdSubject) {
      mdSubject = new Subject<void>()
      const DEBOUNCE_TIME_MS = 20 * 1000 // 20 seconds
      mdSubject.pipe(debounceTime(DEBOUNCE_TIME_MS)).subscribe(async () => {
        try {
          await this.syncMarkdownFile(uri)
        } catch (error) {
          console.error('Failed to synchronise markdown sidecar', uri, error)
        }
      })
      this.markdownSyncSubjects.set(uri, mdSubject)
    }
    mdSubject.next()
  }

  private async getOrBackfillLocalChecksum(
    localUri: string,
    record: LocalFileRecord
  ): Promise<string> {
    const doc = record.doc ?? ''
    if (typeof record.md5Checksum === 'string') {
      // Empty docs intentionally hash to "" and do not need backfill writes.
      if (record.md5Checksum !== '' || doc === '') {
        return record.md5Checksum
      }
    }

    const checksum = checksumForSerializedNotebook(doc)
    await this.files.update(localUri, { md5Checksum: checksum })
    return checksum
  }

  private async ensureFolderRecord(
    id: string,
    name: string
  ): Promise<LocalFolderRecord> {
    const existing = await this.folders.get(id)
    if (existing) {
      return existing
    }
    const record: LocalFolderRecord = {
      id,
      name,
      remoteId: id,
      children: [],
      lastSynced: '',
    }
    await this.folders.put(record)
    return record
  }

  private async decodeUpstreamNotebook({
    localUri,
    record,
    content,
    upstreamFingerprint,
  }: {
    localUri: string
    record: LocalFileRecord
    content: string
    upstreamFingerprint: string
  }): Promise<{
    notebook: parser_pb.Notebook
    serialized: string
    ipynbPreservation?: IpynbPreservationState
  }> {
    const decoded = decodeNotebookFile(content, record.name)
    const serialized = serializeNotebook(decoded.notebook)
    if (!decoded.ipynb) {
      return { notebook: decoded.notebook, serialized }
    }
    const shadowRef = await this.ipynbShadowStorage.write(
      localUri,
      decoded.ipynb.shadowText
    )
    return {
      notebook: decoded.notebook,
      serialized,
      ipynbPreservation: {
        upstreamFingerprint,
        baselineNotebookChecksum: checksumForSerializedNotebook(serialized),
        shadowRef,
        jupyterIdByRunmeRefId: decoded.ipynb.jupyterIdByRunmeRefId,
        baselineCellHashes: decoded.ipynb.baselineCellHashes,
        baselineOutputHashes: decoded.ipynb.baselineOutputHashes,
      },
    }
  }

  private async refreshLocalIpynbShadow(
    localUri: string,
    record: LocalFileRecord
  ): Promise<IpynbPreservationState> {
    const parseResult = parseSerializedNotebook(record.doc ?? '')
    if (!parseResult.ok) {
      throw new Error(
        `Refusing to encode unparsable Runme notebook as .ipynb: ${String(
          parseResult.error
        )}`
      )
    }
    const previousRef = record.ipynbPreservation?.shadowRef
    const shadowText = record.ipynbPreservation
      ? await this.ipynbShadowStorage.read(record.ipynbPreservation.shadowRef)
      : undefined
    const encoded = encodeIpynbNotebook(
      parseResult.notebook,
      shadowText,
      record.ipynbPreservation
    )
    const shadowRef = await this.ipynbShadowStorage.write(
      localUri,
      encoded.text
    )
    const preservation: IpynbPreservationState = {
      upstreamFingerprint: md5(encoded.text),
      baselineNotebookChecksum: checksumForSerializedNotebook(
        serializeNotebook(parseResult.notebook)
      ),
      shadowRef,
      ...encoded.state,
    }
    await this.files.update(localUri, {
      ipynbPreservation: preservation,
    })
    if (previousRef && previousRef.path !== shadowRef.path) {
      await this.ipynbShadowStorage.delete(previousRef).catch(() => {})
    }
    return preservation
  }

  private async deleteReplacedIpynbShadow(
    previous: IpynbPreservationState | undefined,
    next: IpynbPreservationState | undefined
  ): Promise<void> {
    if (previous && previous.shadowRef.path !== next?.shadowRef.path) {
      await this.ipynbShadowStorage.delete(previous.shadowRef).catch(() => {})
    }
  }

  private async loadDriveNotebookDocument(
    localUri: string,
    record: LocalFileRecord,
    upstreamFingerprint: string
  ): Promise<{
    notebook: parser_pb.Notebook
    serialized: string
    ipynbPreservation?: IpynbPreservationState
  }> {
    if (detectNotebookFileFormat(record.name) === 'ipynb') {
      return this.decodeUpstreamNotebook({
        localUri,
        record,
        content: await this.driveStore.loadContent(record.remoteId),
        upstreamFingerprint,
      })
    }
    const notebook = await this.driveStore.load(record.remoteId)
    return { notebook, serialized: serializeNotebook(notebook) }
  }

  /**
   * Derive a fallback display name from the tail of a remote URI. This is a
   * best-effort helper and may return null if no meaningful segment exists.
   */
  private deriveDisplayNameFromUri(uri: string): string | null {
    try {
      const url = new URL(uri)
      const segments = url.pathname.split('/').filter(Boolean)
      if (segments.length > 0) {
        return decodeURIComponent(segments[segments.length - 1])
      }
    } catch {
      // Ignore parse failures and fall bacfk to the simple heuristic below.
    }

    const rawSegments = uri.split('/').filter(Boolean)
    if (rawSegments.length > 0) {
      return rawSegments[rawSegments.length - 1]
    }

    return null
  }

  private async syncFile(localUri: string): Promise<void> {
    const existingSync = this.inFlightSyncs.get(localUri)
    if (existingSync) {
      return existingSync
    }

    const operation = Promise.resolve().then(() =>
      this.driveSyncCoordinator.runExclusive(localUri, async () => {
        try {
          // Re-read and reconcile only after acquiring the cross-context lock.
          // Another tab may have completed the pending create while we waited.
          await this.syncFileInner(localUri)
          await this.files.update(localUri, { lastSyncError: undefined })
        } catch (error) {
          await this.files.update(localUri, { lastSyncError: String(error) })
          throw error
        }
      })
    )
    this.inFlightSyncs.set(localUri, operation)
    this.notifySync(localUri)

    const cleanup = () => {
      if (this.inFlightSyncs.get(localUri) !== operation) {
        return
      }
      this.inFlightSyncs.delete(localUri)
      this.notifySync(localUri)
    }
    void operation.then(cleanup, cleanup)
    return operation
  }

  private async syncFileInner(localUri: string): Promise<void> {
    let record = await this.files.get(localUri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`)
    }
    if (record.conflict) {
      appLogger.info('Skipping automatic sync for conflicted notebook', {
        attrs: {
          scope: 'storage.drive.sync',
          code: 'DRIVE_NOTEBOOK_CONFLICT_SYNC_SKIPPED',
          localUri,
          remoteUri: record.remoteId,
        },
      })
      return
    }

    // Files that do not have a remote counterpart live exclusively in
    // IndexedDB. There is nothing to synchronise for those entries, so we can
    // exit early once we've confirmed the local metadata exists.
    let completedPendingCreate = false
    if (!record.remoteId) {
      if (!record.parentRemoteIdWhenCreated) {
        throw new Error(
          `Local notebook ${localUri} is missing remoteId and pending parent`
        )
      }
      await this.completePendingDriveCreate(localUri, record)
      completedPendingCreate = true
      const updated = await this.files.get(localUri)
      if (!updated?.remoteId) {
        throw new Error(
          `Failed to create Drive file for pending notebook ${localUri}`
        )
      }
      record = updated
    }

    if (isLocalFileUpstream(record.remoteId, localUri)) {
      if (detectNotebookFileFormat(record.name) === 'ipynb') {
        await this.refreshLocalIpynbShadow(localUri, record)
      }
      await this.files.update(localUri, {
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
      })
      return
    }

    if (isFilesystemUri(record.remoteId)) {
      if (detectNotebookFileFormat(record.name) === 'runme-operation-log') {
        await this.syncOperationLogFilesystem(localUri, record)
        return
      }
      await this.syncSerializedNotebookUpstream(localUri, record)
      return
    }

    if (!isDriveUri(record.remoteId)) {
      throw new Error(
        `Unsupported upstream URI ${record.remoteId} for local notebook ${localUri}`
      )
    }

    if (detectNotebookFileFormat(record.name) === 'runme-operation-log') {
      await this.syncOperationLogDrive(localUri, record)
      return
    }

    const remoteUri = record.remoteId

    let remoteName: string | undefined
    try {
      const metadata = await this.driveStore.getMetadata(remoteUri)
      remoteName = metadata?.name
    } catch (error) {
      console.error('Failed to fetch remote metadata for', remoteUri, error)
    }
    if (remoteName && remoteName !== record.name) {
      await this.files.update(localUri, { name: remoteName })
    }

    // Fetch the current checksum from Drive. We treat "missing" as an empty
    // string so downstream comparisons remain simple string equality checks.
    let currentVersion: UpstreamVersion = {}
    let currentRemoteChecksum = ''
    try {
      currentVersion = driveMetadataToUpstreamVersion(
        await this.driveStore.getVersionMetadata(remoteUri)
      )
      currentRemoteChecksum = currentVersion.checksum ?? ''
    } catch (error) {
      console.error(
        'Failed to retrieve remote checksum while synchronising',
        remoteUri,
        error
      )
      throw error
    }

    const lastReadChecksum = record.lastRemoteChecksum ?? ''
    // Drive fingerprints the raw .ipynb bytes, while localChecksum fingerprints
    // the Runme model. Keep a baseline in the same domain as localChecksum so
    // a remote-only edit is not mistaken for a concurrent local edit.
    const lastReadNotebookChecksum =
      detectNotebookFileFormat(record.name) === 'ipynb'
        ? (record.ipynbPreservation?.baselineNotebookChecksum ??
          lastReadChecksum)
        : lastReadChecksum
    const localDoc = record.doc ?? ''
    const localChecksum = await this.getOrBackfillLocalChecksum(
      localUri,
      record
    )
    let synced = false

    if (
      record.mimeType &&
      record.mimeType !== NOTEBOOK_MIME_TYPE &&
      !isNotebookFileName(record.name)
    ) {
      await this.saveLocalDocToDrive(
        localUri,
        remoteUri,
        localDoc,
        record.mimeType
      )
      const updatedVersion = driveMetadataToUpstreamVersion(
        await this.driveStore.getVersionMetadata(remoteUri)
      )
      const updatedChecksum = updatedVersion.checksum ?? localChecksum
      await this.files.update(localUri, {
        lastRemoteChecksum: updatedChecksum,
        lastUpstreamVersion: updatedVersion,
        md5Checksum: localChecksum,
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
      })
      synced = true
      return
    }

    // Case 1: The checksum reported by Drive matches the version we last
    // observed. This means no external party has modified the remote file and
    // the local content is authoritative. We can safely push our data back to
    // Drive without risking data loss.
    if (currentRemoteChecksum === lastReadChecksum) {
      await this.saveLocalDocToDrive(
        localUri,
        remoteUri,
        localDoc,
        record.mimeType
      )
      const updatedVersion = driveMetadataToUpstreamVersion(
        await this.driveStore.getVersionMetadata(remoteUri)
      )
      const updatedChecksum = updatedVersion.checksum ?? ''
      await this.files.update(localUri, {
        lastRemoteChecksum: updatedChecksum,
        lastUpstreamVersion: updatedVersion,
        md5Checksum: localChecksum,
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
      })
      synced = true
      return
    }

    // Case 2: We have never read the remote file (the cache holds an empty
    // checksum) but Drive reports a concrete checksum. Download the remote
    // copy only if the local record has no user-authored content. Otherwise,
    // prefer the local IndexedDB content because overwriting it risks data loss.
    if (!lastReadChecksum && currentRemoteChecksum) {
      if (
        completedPendingCreate &&
        serializedNotebookHasUserContent(localDoc)
      ) {
        await this.saveLocalDocToDrive(
          localUri,
          remoteUri,
          localDoc,
          record.mimeType
        )
        const updatedVersion = driveMetadataToUpstreamVersion(
          await this.driveStore.getVersionMetadata(remoteUri)
        )
        const updatedChecksum = updatedVersion.checksum ?? ''
        await this.files.update(localUri, {
          lastRemoteChecksum: updatedChecksum,
          lastUpstreamVersion: updatedVersion,
          md5Checksum: localChecksum,
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
        })
        synced = true
        return
      }

      if (serializedNotebookHasUserContent(localDoc)) {
        appLogger.warn(
          'Forking local notebook because Drive exists without a baseline checksum',
          {
            attrs: {
              scope: 'storage.drive.sync',
              localUri,
              remoteUri,
              remoteChecksum: currentRemoteChecksum,
              localChecksum,
            },
          }
        )
        await this.recordConflict(
          localUri,
          record,
          currentVersion,
          localChecksum
        )
        synced = true
        return
      }

      const remote = await this.loadDriveNotebookDocument(
        localUri,
        record,
        currentRemoteChecksum
      )
      const serialized = remote.serialized
      logRemoteOverwriteLocalDoc({
        localUri,
        remoteUri,
        localChecksum,
        remoteChecksum: currentRemoteChecksum,
        reason: 'no-local-baseline-checksum',
        localDoc,
        remoteDoc: serialized,
        previousUpstreamRevisionId: record.lastUpstreamVersion?.revisionId,
        upstreamRevisionId: currentVersion.revisionId,
      })
      await this.files.update(localUri, {
        doc: serialized,
        md5Checksum: checksumForSerializedNotebook(serialized),
        lastRemoteChecksum: currentRemoteChecksum,
        lastUpstreamVersion: currentVersion,
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
        ipynbPreservation: remote.ipynbPreservation,
      })
      await this.deleteReplacedIpynbShadow(
        record.ipynbPreservation,
        remote.ipynbPreservation
      )
      synced = true
      return
    }

    // Case 3: Drive reports a different checksum than the one we last synced
    // against. If our local content still matches the old checksum, someone
    // else updated the remote file and we simply need to refresh our cache.
    if (currentRemoteChecksum && currentRemoteChecksum !== lastReadChecksum) {
      if (localChecksum === lastReadNotebookChecksum) {
        const remote = await this.loadDriveNotebookDocument(
          localUri,
          record,
          currentRemoteChecksum
        )
        const serialized = remote.serialized
        logRemoteOverwriteLocalDoc({
          localUri,
          remoteUri,
          localChecksum,
          remoteChecksum: currentRemoteChecksum,
          reason: 'local-matches-previous-remote-baseline',
          localDoc,
          remoteDoc: serialized,
          previousUpstreamRevisionId: record.lastUpstreamVersion?.revisionId,
          upstreamRevisionId: currentVersion.revisionId,
        })
        await this.files.update(localUri, {
          doc: serialized,
          md5Checksum: checksumForSerializedNotebook(serialized),
          lastRemoteChecksum: currentRemoteChecksum,
          lastUpstreamVersion: currentVersion,
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
          ipynbPreservation: remote.ipynbPreservation,
        })
        await this.deleteReplacedIpynbShadow(
          record.ipynbPreservation,
          remote.ipynbPreservation
        )
        synced = true
        return
      }

      // The remote file changed AND we have unapplied local changes (the local
      // checksum diverges from the shared base). Record a durable conflict and
      // wait for the user to choose which version should win.
      await this.recordConflict(localUri, record, currentVersion, localChecksum)
      synced = true
      return
    }

    // Case 4: The remote file does not have a checksum (e.g. an empty file).
    // If we have local content we attempt to seed Drive with it; otherwise we
    // keep the baseline empty.
    if (!currentRemoteChecksum) {
      if (localDoc) {
        await this.saveLocalDocToDrive(
          localUri,
          remoteUri,
          localDoc,
          record.mimeType
        )
        const updatedVersion = driveMetadataToUpstreamVersion(
          await this.driveStore.getVersionMetadata(remoteUri)
        )
        const updatedChecksum = updatedVersion.checksum ?? ''
        await this.files.update(localUri, {
          lastRemoteChecksum: updatedChecksum,
          lastUpstreamVersion: updatedVersion,
          md5Checksum: localChecksum,
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
        })
        synced = true
      } else if (lastReadChecksum) {
        await this.files.update(localUri, {
          lastRemoteChecksum: '',
          lastUpstreamVersion: currentVersion,
          md5Checksum: localChecksum,
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
        })
        synced = true
      }
    }

    if (!synced) {
      await this.files.update(localUri, {
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
      })
    }
  }

  private async saveLocalDocToDrive(
    localUri: string,
    remoteUri: string,
    localDoc: string,
    mimeType: string | undefined
  ): Promise<void> {
    const record = await this.files.get(localUri)
    if (!record) {
      throw new Error(`Local notebook record not found for ${localUri}`)
    }
    if (
      mimeType &&
      mimeType !== NOTEBOOK_MIME_TYPE &&
      !isNotebookFileName(record.name)
    ) {
      await this.driveStore.saveContent(remoteUri, localDoc, mimeType)
      return
    }

    if (detectNotebookFileFormat(record.name) === 'ipynb') {
      const parseResult = parseSerializedNotebook(localDoc)
      if (!parseResult.ok) {
        throw new Error(
          `Refusing to save unparsable Runme notebook as .ipynb: ${String(
            parseResult.error
          )}`
        )
      }
      let shadowText: string | undefined
      if (record.ipynbPreservation) {
        shadowText = await this.ipynbShadowStorage.read(
          record.ipynbPreservation.shadowRef
        )
      }
      const encoded = encodeIpynbNotebook(
        parseResult.notebook,
        shadowText,
        record.ipynbPreservation
      )
      await this.driveStore.saveContent(
        remoteUri,
        encoded.text,
        IPYNB_MIME_TYPE
      )
      const upstreamFingerprint =
        (await this.driveStore.getVersionMetadata(remoteUri))?.md5Checksum ??
        md5(encoded.text)
      const shadowRef = await this.ipynbShadowStorage.write(
        localUri,
        encoded.text
      )
      const previousRef = record.ipynbPreservation?.shadowRef
      await this.files.update(localUri, {
        ipynbPreservation: {
          upstreamFingerprint,
          baselineNotebookChecksum: checksumForSerializedNotebook(localDoc),
          shadowRef,
          ...encoded.state,
        },
      })
      if (previousRef && previousRef.path !== shadowRef.path) {
        await this.ipynbShadowStorage.delete(previousRef).catch(() => {})
      }
      return
    }

    if (!localDoc) {
      await this.driveStore.save(
        remoteUri,
        create(parser_pb.NotebookSchema, { cells: [] })
      )
      return
    }

    const parseResult = parseSerializedNotebook(localDoc)
    if (parseResult.ok) {
      await this.driveStore.save(remoteUri, parseResult.notebook)
      return
    }

    appLogger.warn('Saving raw local notebook JSON because parsing failed', {
      attrs: {
        scope: 'storage.drive.sync',
        localUri,
        remoteUri,
        error: String(parseResult.error),
      },
    })
    await this.driveStore.saveContent(remoteUri, localDoc, 'application/json')
  }

  /** Download .runme bytes only when they match the observed Drive version. */
  private async loadConsistentDriveOperationLogSnapshot(
    remoteId: string
  ): Promise<{
    content: string
    version: DriveVersionMetadata | null
  } | null> {
    const before = await this.driveStore.getVersionMetadata(remoteId)
    const content = await this.driveStore.loadContent(remoteId)
    const after = await this.driveStore.getVersionMetadata(remoteId)
    if (after?.md5Checksum !== undefined) {
      // When another tab saves between the first metadata read and the media
      // download, the downloaded bytes can already be the newer complete
      // revision. Accept that self-consistent snapshot instead of discarding
      // it solely because `before` is stale.
      if (md5(content) !== after.md5Checksum) return null
    } else if (!sameDriveVersion(before, after)) {
      return null
    }
    return { content, version: after }
  }

  /** Merge a raw .runme operation set with Drive using bounded CAS retries. */
  private async syncOperationLogDrive(
    localUri: string,
    record: LocalFileRecord
  ): Promise<void> {
    if (!record.operationLogRef) {
      // An empty Drive file has no operation-log identity yet. Generate one
      // seed once, then claim the empty revision with CAS so concurrent
      // initializers cannot create competing notebook IDs.
      const initialDocument = createInitialNotebookFile(record.name)
      for (
        let attempt = 0;
        attempt < DRIVE_OPERATION_LOG_MERGE_ATTEMPTS;
        attempt += 1
      ) {
        const snapshot = await this.loadConsistentDriveOperationLogSnapshot(
          record.remoteId
        )
        if (!snapshot) continue

        let remoteContent = snapshot.content
        let remoteVersion = snapshot.version
        if (remoteContent === '') {
          appLogger.info('Initializing zero-byte Drive operation log', {
            attrs: {
              scope: 'storage.drive.sync',
              code: 'DRIVE_OPERATION_LOG_INITIALIZE_EMPTY',
              localUri,
              remoteUri: record.remoteId,
              source: 'new-mirror',
            },
          })
          const saved = await this.driveStore.saveContentIfVersion(
            record.remoteId,
            initialDocument,
            RUNME_OPERATION_LOG_MIME_TYPE,
            {
              checksum: snapshot.version?.md5Checksum,
              revisionId: snapshot.version?.headRevisionId,
              version: snapshot.version?.version,
            }
          )
          if (!saved) continue
          remoteContent = initialDocument
          remoteVersion = await this.driveStore.getVersionMetadata(
            record.remoteId
          )
        }

        const remote = parseOperationLog(remoteContent)
        const stored = await this.operationLogStorage.initialize(
          localUri,
          serializeOperationLog(remote.header, remote.operations, {
            canonicalOrder: true,
          })
        )
        const version = driveMetadataToUpstreamVersion(remoteVersion)
        await this.files.update(localUri, {
          doc: '',
          operationLogRef: stored.ref,
          md5Checksum: stored.checksum,
          lastRemoteChecksum: version.checksum ?? md5(remoteContent),
          lastUpstreamVersion: version,
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
        })
        return
      }
      throw new Error(
        `Drive operation log changed during ${DRIVE_OPERATION_LOG_MERGE_ATTEMPTS} merge attempts for ${localUri}`
      )
    }

    for (
      let attempt = 0;
      attempt < DRIVE_OPERATION_LOG_MERGE_ATTEMPTS;
      attempt += 1
    ) {
      const local = await this.operationLogStorage.read(record.operationLogRef)
      const snapshot = await this.loadConsistentDriveOperationLogSnapshot(
        record.remoteId
      )
      if (!snapshot) continue
      const remoteContent = snapshot.content

      const localLog = parseOperationLog(local.document)
      // A zero-byte Drive file is an uninitialized upstream, not a malformed
      // operation log. Use the local header as its identity and force a CAS
      // upload below. Non-empty malformed content remains a hard error.
      const remoteWasEmpty = remoteContent === ''
      const remoteLog: ParsedOperationLog = remoteWasEmpty
        ? { header: localLog.header, operations: [] }
        : parseOperationLog(remoteContent)
      if (remoteWasEmpty) {
        appLogger.info('Initializing zero-byte Drive operation log', {
          attrs: {
            scope: 'storage.drive.sync',
            code: 'DRIVE_OPERATION_LOG_INITIALIZE_EMPTY',
            localUri,
            remoteUri: record.remoteId,
            source: 'local-operation-log',
          },
        })
      }
      if (localLog.header.notebook_id !== remoteLog.header.notebook_id) {
        throw new Error(
          `Cannot merge different operation-log notebooks for ${localUri}`
        )
      }
      const mergedOperations = mergeOperationSets(
        localLog.operations,
        remoteLog.operations
      )
      const localIds = new Set(
        localLog.operations.map((operation) => operation.op_id)
      )
      const remoteIds = new Set(
        remoteLog.operations.map((operation) => operation.op_id)
      )
      const missingLocally = mergedOperations.filter(
        (operation) => !localIds.has(operation.op_id)
      )
      let stored = local
      if (missingLocally.length > 0) {
        try {
          stored = await this.operationLogStorage.append(
            local.ref,
            `${missingLocally
              .map((operation) =>
                canonicalJson(operation as unknown as JsonValue)
              )
              .join('\n')}\n`,
            { validate: (document) => void parseOperationLog(document) }
          )
        } catch {
          continue
        }
      }

      const mergedDocument = serializeOperationLog(
        localLog.header,
        mergedOperations,
        { canonicalOrder: true }
      )
      if (
        remoteWasEmpty ||
        mergedOperations.some((operation) => !remoteIds.has(operation.op_id))
      ) {
        const saved = await this.driveStore.saveContentIfVersion(
          record.remoteId,
          mergedDocument,
          RUNME_OPERATION_LOG_MIME_TYPE,
          {
            checksum: snapshot.version?.md5Checksum,
            revisionId: snapshot.version?.headRevisionId,
            version: snapshot.version?.version,
          }
        )
        if (!saved) continue
      }
      const version = driveMetadataToUpstreamVersion(
        await this.driveStore.getVersionMetadata(record.remoteId)
      )
      const latestLocal = await this.operationLogStorage.read(local.ref)
      await this.files.update(localUri, {
        doc: '',
        operationLogRef: latestLocal.ref,
        md5Checksum: latestLocal.checksum,
        // For operation logs this is the local byte snapshot whose operation
        // set was uploaded. The upstream may use a different canonical record
        // order while representing the same set.
        lastRemoteChecksum: stored.checksum,
        lastUpstreamVersion: version,
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
      })
      if (latestLocal.checksum !== stored.checksum) {
        // An append landed while the remote save was in flight. Preserve its
        // pending status and schedule a follow-up sync instead of losing the
        // only enqueue to the in-flight promise.
        this.enqueueSync(localUri)
      }
      return
    }

    throw new Error(
      `Drive operation log changed during ${DRIVE_OPERATION_LOG_MERGE_ATTEMPTS} merge attempts for ${localUri}`
    )
  }

  private async completePendingDriveCreate(
    localUri: string,
    record: LocalFileRecord
  ): Promise<void> {
    const parentRemoteUri = record.parentRemoteIdWhenCreated
    if (!parentRemoteUri) {
      throw new Error(`Missing pending Drive parent for ${localUri}`)
    }
    if (!isDriveUri(parentRemoteUri)) {
      throw new Error(
        `Pending upstream parent is not a Drive folder for ${localUri}: ${parentRemoteUri}`
      )
    }

    const createOperationId = record.driveCreateOperationId ?? uuidv4()
    if (!record.driveCreateOperationId) {
      await this.files.update(localUri, {
        driveCreateOperationId: createOperationId,
      })
    }
    const existingFile = await this.driveStore.findByCreateOperation(
      parentRemoteUri,
      createOperationId
    )
    let newFile = existingFile
    const format = detectNotebookFileFormat(record.name)
    if (!newFile && format === 'runme-operation-log') {
      if (!record.operationLogRef) {
        throw new Error(`Operation-log reference missing for ${localUri}`)
      }
      const content = (
        await this.operationLogStorage.read(record.operationLogRef)
      ).document
      newFile = await this.driveStore.createContent(
        parentRemoteUri,
        record.name,
        content,
        RUNME_OPERATION_LOG_MIME_TYPE,
        { createOperationId }
      )
    } else if (!newFile && format === 'ipynb') {
      const shadow = record.ipynbPreservation
        ? await this.ipynbShadowStorage.read(record.ipynbPreservation.shadowRef)
        : createInitialNotebookFile(record.name)
      newFile = await this.driveStore.createContent(
        parentRemoteUri,
        record.name,
        shadow,
        IPYNB_MIME_TYPE,
        { createOperationId }
      )
    } else if (
      !newFile &&
      record.mimeType &&
      record.mimeType !== NOTEBOOK_MIME_TYPE
    ) {
      newFile = await this.driveStore.createContent(
        parentRemoteUri,
        record.name,
        record.doc ?? '',
        record.mimeType ?? 'application/octet-stream',
        { createOperationId }
      )
    } else if (!newFile) {
      newFile = await this.driveStore.create(parentRemoteUri, record.name, {
        createOperationId,
      })
    }
    let version: UpstreamVersion = {}
    try {
      version = driveMetadataToUpstreamVersion(
        await this.driveStore.getVersionMetadata(newFile.uri)
      )
    } catch (error) {
      appLogger.warn(
        'Failed to record version metadata for new Drive notebook',
        {
          attrs: {
            scope: 'storage.drive.sync',
            localUri,
            remoteUri: newFile.uri,
            error: String(error),
          },
        }
      )
    }
    const currentRecord = await this.files.get(localUri)
    const localDoc = currentRecord?.doc ?? record.doc ?? ''
    const hasLocalContent = serializedNotebookHasUserContent(localDoc)

    await this.files.update(localUri, {
      name: newFile.name ?? record.name,
      mimeType: newFile.mimeType ?? record.mimeType ?? NOTEBOOK_MIME_TYPE,
      remoteId: newFile.uri,
      parentRemoteIdWhenCreated: undefined,
      lastRemoteChecksum: version.checksum ?? '',
      lastUpstreamVersion: version,
      lastSynced: hasLocalContent ? '' : nowIsoString(),
      lastSyncError: undefined,
    })

    appLogger.info('Created pending Drive notebook upstream file', {
      attrs: {
        scope: 'storage.drive.sync',
        localUri,
        parentRemoteUri,
        remoteUri: newFile.uri,
        createOperationId,
        outcome: existingFile ? 'adopted' : 'created',
        upstreamChecksum: version.checksum,
        upstreamRevisionId: version.revisionId,
      },
    })

    if (canDispatchWindowEvents()) {
      window.dispatchEvent(
        new CustomEvent('local-notebook-updated', {
          detail: {
            uri: localUri,
            name: newFile.name ?? record.name,
            remoteUri: newFile.uri,
          },
        })
      )
    }
  }

  private resolveSerializedNotebookStore(upstreamUri: string): {
    load(uri: string): Promise<parser_pb.Notebook>
    save(uri: string, notebook: parser_pb.Notebook): Promise<unknown>
    loadContent?(uri: string): Promise<string>
    saveContent?(uri: string, content: string): Promise<void>
  } | null {
    if (isFilesystemUri(upstreamUri)) {
      return this.filesystemStore
    }
    return null
  }

  /** Merge the browser OPFS log with a filesystem-backed .runme file. */
  private async syncOperationLogFilesystem(
    localUri: string,
    record: LocalFileRecord
  ): Promise<void> {
    const upstreamStore = this.resolveSerializedNotebookStore(record.remoteId)
    if (!upstreamStore?.loadContent || !upstreamStore.saveContent) {
      throw new Error('Filesystem store cannot synchronize raw .runme content')
    }
    if (!record.operationLogRef) {
      const upstreamDocument = await upstreamStore.loadContent(record.remoteId)
      const upstream = parseOperationLog(upstreamDocument)
      const stored = await this.operationLogStorage.initialize(
        localUri,
        serializeOperationLog(upstream.header, upstream.operations, {
          canonicalOrder: true,
        })
      )
      const checksum = md5(upstreamDocument)
      await this.files.update(localUri, {
        doc: '',
        operationLogRef: stored.ref,
        md5Checksum: stored.checksum,
        lastRemoteChecksum: checksum,
        lastUpstreamVersion: { checksum },
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
      })
      return
    }

    const local = await this.operationLogStorage.read(record.operationLogRef)
    const upstreamDocument = await upstreamStore.loadContent(record.remoteId)
    const localLog = parseOperationLog(local.document)
    const upstreamLog = parseOperationLog(upstreamDocument)
    if (localLog.header.notebook_id !== upstreamLog.header.notebook_id) {
      throw new Error(
        `Cannot merge different operation-log notebooks for ${localUri}`
      )
    }
    const mergedOperations = mergeOperationSets(
      localLog.operations,
      upstreamLog.operations
    )
    const localIds = new Set(
      localLog.operations.map((operation) => operation.op_id)
    )
    const upstreamIds = new Set(
      upstreamLog.operations.map((operation) => operation.op_id)
    )
    const missingLocally = mergedOperations.filter(
      (operation) => !localIds.has(operation.op_id)
    )
    let stored = local
    if (missingLocally.length > 0) {
      stored = await this.operationLogStorage.append(
        local.ref,
        `${missingLocally
          .map((operation) => canonicalJson(operation as unknown as JsonValue))
          .join('\n')}\n`,
        { validate: (document) => void parseOperationLog(document) }
      )
    }
    const mergedDocument = serializeOperationLog(
      localLog.header,
      mergedOperations,
      { canonicalOrder: true }
    )
    if (
      mergedOperations.some((operation) => !upstreamIds.has(operation.op_id))
    ) {
      await upstreamStore.saveContent(record.remoteId, mergedDocument)
    }
    const checksum = md5(mergedDocument)
    const latestLocal = await this.operationLogStorage.read(local.ref)
    await this.files.update(localUri, {
      doc: '',
      operationLogRef: latestLocal.ref,
      md5Checksum: latestLocal.checksum,
      lastRemoteChecksum: stored.checksum,
      lastUpstreamVersion: { checksum },
      lastSynced: nowIsoString(),
      lastSyncError: undefined,
    })
    if (latestLocal.checksum !== stored.checksum) {
      this.enqueueSync(localUri)
    }
  }

  private async syncSerializedNotebookUpstream(
    localUri: string,
    record: LocalFileRecord
  ): Promise<void> {
    const upstreamUri = record.remoteId
    const upstreamStore = this.resolveSerializedNotebookStore(upstreamUri)
    if (!upstreamStore) {
      appLogger.warn(
        'Skipping notebook sync because upstream store is unavailable',
        {
          attrs: {
            scope: 'storage.local.sync',
            localUri,
            upstreamUri,
          },
        }
      )
      return
    }

    const localDoc = record.doc ?? ''
    const localChecksum = await this.getOrBackfillLocalChecksum(
      localUri,
      record
    )
    const lastRemoteChecksum = record.lastRemoteChecksum ?? ''
    const isIpynb = detectNotebookFileFormat(record.name) === 'ipynb'
    const readUpstream = async () => {
      if (isIpynb) {
        if (!upstreamStore.loadContent) {
          throw new Error('Filesystem store cannot read raw .ipynb content')
        }
        const content = await upstreamStore.loadContent(upstreamUri)
        return this.decodeUpstreamNotebook({
          localUri,
          record,
          content,
          upstreamFingerprint: md5(content),
        })
      }
      const notebook = await upstreamStore.load(upstreamUri)
      return { notebook, serialized: serializeNotebook(notebook) }
    }

    if (!localDoc) {
      const upstream = await readUpstream()
      const upstreamDoc = upstream.serialized
      await this.files.update(localUri, {
        doc: upstreamDoc,
        md5Checksum: checksumForSerializedNotebook(upstreamDoc),
        lastRemoteChecksum: checksumForSerializedNotebook(upstreamDoc),
        lastUpstreamVersion: {
          checksum: checksumForSerializedNotebook(upstreamDoc),
        },
        lastSynced: nowIsoString(),
        lastSyncError: undefined,
        ipynbPreservation: upstream.ipynbPreservation,
      })
      await this.deleteReplacedIpynbShadow(
        record.ipynbPreservation,
        upstream.ipynbPreservation
      )
      return
    }

    const upstream = await readUpstream()
    const upstreamDoc = upstream.serialized
    const upstreamChecksum = checksumForSerializedNotebook(upstreamDoc)

    if (upstreamChecksum !== lastRemoteChecksum) {
      if (localChecksum === lastRemoteChecksum) {
        logRemoteOverwriteLocalDoc({
          localUri,
          remoteUri: upstreamUri,
          localChecksum,
          remoteChecksum: upstreamChecksum,
          reason: 'local-matches-previous-upstream-baseline',
          localDoc,
          remoteDoc: upstreamDoc,
        })
        await this.files.update(localUri, {
          doc: upstreamDoc,
          md5Checksum: upstreamChecksum,
          lastRemoteChecksum: upstreamChecksum,
          lastUpstreamVersion: {
            checksum: upstreamChecksum,
          },
          lastSynced: nowIsoString(),
          lastSyncError: undefined,
          ipynbPreservation: upstream.ipynbPreservation,
        })
        await this.deleteReplacedIpynbShadow(
          record.ipynbPreservation,
          upstream.ipynbPreservation
        )
        return
      }

      appLogger.warn(
        'Refusing to overwrite changed local and upstream notebooks',
        {
          attrs: {
            scope: 'storage.local.sync',
            localUri,
            upstreamUri,
            localChecksum,
            upstreamChecksum,
            lastRemoteChecksum,
          },
        }
      )
      await this.deleteReplacedIpynbShadow(
        upstream.ipynbPreservation,
        record.ipynbPreservation
      )
      return
    }

    const parseResult = parseSerializedNotebook(localDoc)
    if (!parseResult.ok) {
      appLogger.warn('Refusing to sync unparsable local notebook to upstream', {
        attrs: {
          scope: 'storage.local.sync',
          localUri,
          upstreamUri,
          error: String(parseResult.error),
        },
      })
      return
    }

    if (isIpynb) {
      if (!upstreamStore.saveContent) {
        throw new Error('Filesystem store cannot write raw .ipynb content')
      }
      const mergePreservation =
        upstream.ipynbPreservation ?? record.ipynbPreservation
      const shadowText = mergePreservation
        ? await this.ipynbShadowStorage.read(mergePreservation.shadowRef)
        : undefined
      const encoded = encodeIpynbNotebook(
        parseResult.notebook,
        shadowText,
        mergePreservation
      )
      await upstreamStore.saveContent(upstreamUri, encoded.text)
      const shadowRef = await this.ipynbShadowStorage.write(
        localUri,
        encoded.text
      )
      const preservation: IpynbPreservationState = {
        upstreamFingerprint: md5(encoded.text),
        baselineNotebookChecksum: localChecksum,
        shadowRef,
        ...encoded.state,
      }
      await this.files.update(localUri, {
        ipynbPreservation: preservation,
      })
      await this.deleteReplacedIpynbShadow(
        record.ipynbPreservation,
        preservation
      )
      await this.deleteReplacedIpynbShadow(
        upstream.ipynbPreservation,
        preservation
      )
    } else {
      await upstreamStore.save(upstreamUri, parseResult.notebook)
    }
    await this.files.update(localUri, {
      lastRemoteChecksum: localChecksum,
      lastUpstreamVersion: {
        checksum: localChecksum,
      },
      md5Checksum: localChecksum,
      lastSynced: nowIsoString(),
      lastSyncError: undefined,
    })
  }

  private async recordConflict(
    localUri: string,
    record: LocalFileRecord,
    upstreamVersion: UpstreamVersion,
    localChecksum: string
  ): Promise<void> {
    if (!record.remoteId) {
      throw new Error('Unable to resolve conflict without a remoteId')
    }
    if (!isDriveUri(record.remoteId)) {
      throw new Error(
        `Conflict recording is only supported for Drive-backed notebooks; got ${record.remoteId}`
      )
    }

    const upstream = await this.loadDriveNotebookDocument(
      localUri,
      record,
      upstreamVersion.checksum ?? ''
    )
    const upstreamDoc = upstream.serialized
    const upstreamChecksum =
      upstreamVersion.checksum || checksumForSerializedNotebook(upstreamDoc)
    const conflict = await this.createConflictState({
      localUri,
      upstreamDoc,
      upstreamChecksum,
      upstreamVersion,
      localChecksumAtDetection: localChecksum,
    })

    await this.files.update(localUri, {
      conflict,
      lastSyncError: undefined,
    })

    appLogger.warn('Notebook sync conflict recorded', {
      attrs: {
        scope: 'storage.drive.sync',
        code: 'DRIVE_NOTEBOOK_CONFLICT_RECORDED',
        localUri,
        remoteUri: record.remoteId,
        lastRemoteChecksum: record.lastRemoteChecksum,
        localChecksum,
        upstreamChecksum,
        upstreamRevisionId: upstreamVersion.revisionId,
      },
    })
    this.notifySync(localUri)
  }

  private async createConflictState({
    localUri,
    upstreamDoc,
    upstreamChecksum,
    upstreamVersion,
    localChecksumAtDetection,
    detectedAt = nowIsoString(),
  }: {
    localUri: string
    upstreamDoc: string
    upstreamChecksum: string
    upstreamVersion?: UpstreamVersion
    localChecksumAtDetection: string
    detectedAt?: string
  }): Promise<NotebookConflictState> {
    const upstreamDocRef = await this.getConflictDocStorage().write(
      localUri,
      upstreamDoc
    )
    return {
      detectedAt,
      upstreamChecksum,
      upstreamVersion,
      upstreamDocRef,
      localChecksumAtDetection,
    }
  }

  private getConflictDocStorage(): ConflictDocStorage {
    return this.conflictDocStorage ?? createDefaultConflictDocStorage()
  }

  private getRevisionDocStorage(): RevisionDocStorage {
    return this.revisionDocStorage ?? createDefaultRevisionDocStorage()
  }

  private async deleteConflictDoc(
    conflict: NotebookConflictState | undefined
  ): Promise<void> {
    if (!conflict?.upstreamDocRef) {
      return
    }
    try {
      await this.getConflictDocStorage().delete(conflict.upstreamDocRef)
    } catch (error) {
      appLogger.warn('Failed to delete conflict document from OPFS', {
        attrs: {
          scope: 'storage.drive.sync',
          code: 'DRIVE_NOTEBOOK_CONFLICT_DOC_DELETE_FAILED',
          path: conflict.upstreamDocRef.path,
          error: String(error),
        },
      })
    }
  }

  private async findParentFolder(
    childUri: string
  ): Promise<LocalFolderRecord | null> {
    const folder = await this.folders
      .filter((folder) => folder.children.includes(childUri))
      .first()
    return folder ?? null
  }

  private async syncFolder(localUri: string): Promise<void> {
    const record = await this.folders.get(localUri)
    if (!record) {
      throw new Error(`Local folder not found for ${localUri}`)
    }

    if (!isDriveUri(record.remoteId)) {
      await this.folders.update(localUri, {
        lastSynced: nowIsoString(),
      })
      return
    }

    try {
      const metadata = await this.driveStore.getMetadata(record.remoteId)
      if (metadata?.name && metadata.name !== record.name) {
        await this.folders.update(localUri, { name: metadata.name })
      }
    } catch (error) {
      console.error(
        'Failed to fetch remote folder metadata for',
        record.remoteId,
        error
      )
    }

    await this.updateFolder(record.remoteId, record.name)
    await this.folders.update(localUri, {
      lastSynced: nowIsoString(),
    })
  }
}

export default LocalNotebooks

function checksumForSerializedNotebook(serialized: string): string {
  return serialized ? md5(serialized) : ''
}

function serializeNotebook(notebook: parser_pb.Notebook): string {
  return toJsonString(
    parser_pb.NotebookSchema,
    notebook,
    NOTEBOOK_JSON_WRITE_OPTIONS
  )
}

function deserializeNotebook(json: string): parser_pb.Notebook {
  if (!json) {
    return create(parser_pb.NotebookSchema, { cells: [] })
  }
  const parsed = parseSerializedNotebook(json)
  if (parsed.ok) {
    return parsed.notebook
  }
  console.error(
    'Falling back to empty notebook due to parse failure',
    parsed.error
  )
  return create(parser_pb.NotebookSchema, { cells: [] })
}

function parseSerializedNotebook(
  json: string
): { ok: true; notebook: parser_pb.Notebook } | { ok: false; error: unknown } {
  try {
    return {
      ok: true,
      notebook: fromJsonString(parser_pb.NotebookSchema, json, {
        ignoreUnknownFields: true,
      }),
    }
  } catch (error) {
    return { ok: false, error }
  }
}

function serializedNotebookHasUserContent(json: string): boolean {
  if (!json) {
    return false
  }
  try {
    const notebook = fromJsonString(parser_pb.NotebookSchema, json, {
      ignoreUnknownFields: true,
    })
    return (
      notebook.cells.length > 0 ||
      Object.keys(notebook.metadata ?? {}).length > 0
    )
  } catch (error) {
    appLogger.warn('Preserving unparsable local notebook content', {
      attrs: {
        scope: 'storage.drive.sync',
        error: String(error),
      },
    })
    return true
  }
}

function driveMetadataToUpstreamVersion(
  metadata: DriveVersionMetadata | null
): UpstreamVersion {
  return {
    checksum: metadata?.md5Checksum,
    revisionId: metadata?.headRevisionId,
  }
}

function syncStateForRecord(
  record: LocalFileRecord,
  status: NotebookSyncStatus,
  fallbackError?: string
): NotebookSyncState {
  return {
    status,
    localUri: record.id,
    remoteId: record.remoteId,
    parentRemoteIdWhenCreated: record.parentRemoteIdWhenCreated,
    lastSynced: record.lastSynced || undefined,
    lastUpstreamVersion: record.lastUpstreamVersion,
    conflict: summarizeConflictForSync(record.conflict),
    lastError: record.lastSyncError || fallbackError,
  }
}

function summarizeConflictForSync(
  conflict: NotebookConflictState | undefined
): NotebookConflictSummary | undefined {
  if (!conflict) {
    return undefined
  }
  return {
    detectedAt: conflict.detectedAt,
    upstreamChecksum: conflict.upstreamChecksum,
    upstreamVersion: conflict.upstreamVersion,
    upstreamDocRef: conflict.upstreamDocRef,
    upstreamDocSizeBytes:
      conflict.upstreamDocRef?.sizeBytes ??
      (typeof conflict.upstreamDoc === 'string'
        ? new TextEncoder().encode(conflict.upstreamDoc).byteLength
        : undefined),
    localChecksumAtDetection: conflict.localChecksumAtDetection,
  }
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
  localUri: string
  remoteUri: string
  localChecksum: string
  remoteChecksum: string
  previousUpstreamRevisionId?: string
  upstreamRevisionId?: string
  reason: string
  localDoc: string
  remoteDoc: string
}): void {
  if (localDoc === remoteDoc) {
    return
  }
  appLogger.warn('Overwriting local notebook content with upstream content', {
    attrs: {
      scope: 'storage.local.sync',
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
  })
}

function nowIsoString(): string {
  return new Date().toISOString()
}

function canDispatchWindowEvents(): boolean {
  return (
    typeof window !== 'undefined' && typeof window.dispatchEvent === 'function'
  )
}

function needsSync(lastSynced: string | undefined, maxAgeMs: number): boolean {
  if (!lastSynced) {
    return true
  }
  const parsed = Date.parse(lastSynced)
  if (Number.isNaN(parsed)) {
    return true
  }
  return Date.now() - parsed > maxAgeMs
}

function isDriveUri(uri: string | undefined): boolean {
  return isDriveItemUri(uri)
}

function isLocalFileUpstream(
  upstreamUri: string | undefined,
  localUri?: string
): boolean {
  if (!upstreamUri) {
    return false
  }
  if (localUri && upstreamUri === localUri) {
    return true
  }
  return upstreamUri.startsWith('local://file/')
}

function publicRemoteUri(record: {
  id: string
  remoteId: string
}): string | undefined {
  return isLocalFileUpstream(record.remoteId, record.id)
    ? undefined
    : record.remoteId || undefined
}

/** Return whether a newly added Drive mirror is still safe to initialize. */
function isUninitializedDriveMirror(record: LocalFileRecord): boolean {
  return (
    record.doc === '' &&
    record.lastSynced === '' &&
    !record.lastRemoteChecksum &&
    !record.conflict
  )
}

function resolveDocumentMimeType(
  name: string | undefined,
  mimeType: string | undefined
): string | undefined {
  if (isExcalidrawFileName(name)) {
    return EXCALIDRAW_MIME_TYPE
  }
  if (detectNotebookFileFormat(name ?? '') === 'ipynb') {
    return IPYNB_MIME_TYPE
  }
  if (detectNotebookFileFormat(name ?? '') === 'runme-json') {
    return NOTEBOOK_MIME_TYPE
  }
  if (detectNotebookFileFormat(name ?? '') === 'runme-operation-log') {
    return RUNME_OPERATION_LOG_MIME_TYPE
  }
  const trimmedMimeType = mimeType?.trim()
  if (trimmedMimeType) {
    return trimmedMimeType
  }
  return undefined
}

function isFilesystemUri(uri: string | undefined): boolean {
  return uri?.startsWith('fs://') ?? false
}
