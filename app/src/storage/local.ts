import { create, fromJsonString, toJsonString } from '@bufbuild/protobuf'
import Dexie, { Table } from 'dexie'
import md5 from 'md5'
import { Subject, debounceTime } from 'rxjs'
import { v4 as uuidv4 } from 'uuid'

import { migrateNotebookCellIds } from '../lib/cellIdentity'
import { encodeDerivedIpynb } from '../lib/derivedIpynb'
import { AUTO_IPYNB_KEY } from '../lib/derivedNotebook'
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
  type SuggestionDecision,
  type SuggestionReviewPayload,
  allocatePositionBetween,
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
import { cellDecisionFor } from '../lib/operationLog/cellReview'
import {
  cellStateKey,
  withCellReviewKeys,
} from '../lib/operationLog/cellReviewIdentity'
import {
  computeReviewDiff,
  normalizeReviewCellIds,
  reviewIdentityKey,
} from '../lib/operationLog/reviewScope'
import {
  type Attribution,
  REVIEW_OUTCOMES,
  type ReviewOutcome,
  buildReviewRounds,
  captureReviewRevision,
  normalizeAttribution,
} from '../lib/operationLog/reviews'
import {
  buildNotebookRevisions,
  materializeRevision,
  revisionFollows,
  revisionKey,
} from '../lib/operationLog/revisions'
import { appState } from '../lib/runtime/AppState'
import { RunmeMetadataKey, parser_pb } from '../runme/client'
import {
  type ConflictDocStorage,
  type ConflictDocumentRef,
  createDefaultConflictDocStorage,
} from './conflictDocs'
import { UnconfirmedDerivedCopyError, ensureDerivedCopy } from './derivedCopy'
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
  type DriveRecoveryCheckpoint,
  DriveRevisionRecovery,
} from './driveRevisionRecovery'
import {
  type DriveSyncCoordinator,
  browserDriveSyncCoordinator,
} from './driveSyncCoordinator'
import { EXCALIDRAW_MIME_TYPE, isExcalidrawFileName } from './excalidraw'
import {
  FilesystemEntryAlreadyExistsError,
  type FilesystemNotebookStore,
} from './fs'
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

// A collaborator can write several Drive revisions in a row while
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
  /** Retry/deduplication state for a legacy-to-Runme Drive copy. */
  legacyConversionAttempt?: {
    originalGoogleDriveId: string
    sourceChecksum: string
    /** Set after sync so callers already waiting on the same lock reuse it. */
    completedAt?: string
  }
  /** Remote Drive URI of the Markdown sidecar (e.g. *.index.md) if present. */
  markdownUri?: string
  /** Derived Colab copy identity and last export outcome; source option lives in the journal. */
  ipynbExportUri?: string
  ipynbExportSourceUri?: string
  /** The exact upstream claim that an explicit recovery action may clear. */
  ipynbExportPendingClaim?: string
  ipynbExportError?: string
  ipynbExportedAt?: string
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
  /** Durable history boundary and unfinished .runme recovery work (no media bytes). */
  driveRecoveryCheckpoint?: DriveRecoveryCheckpoint
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

/** A journal mutation produced records, but a later failure obscured commit state. */
export class OperationLogMutationCommitUncertainError extends Error {
  constructor(
    readonly uri: string,
    readonly operationKind: string,
    readonly cause: unknown
  ) {
    super(
      `The ${operationKind} operation may already be committed for ${uri}: ${String(cause)}`
    )
    this.name = 'OperationLogMutationCommitUncertainError'
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
  private readonly ipynbSyncSubjects = new Map<string, Subject<void>>()
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
      const saved = await this.driveStore.saveContentAfterVersionCheck(
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
    localFileUri: string,
    options: { renewProvisionalAttachment?: boolean } = {}
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
                [localFileUri]: options.renewProvisionalAttachment
                  ? Date.now()
                  : (folder.provisionalChildrenAttachedAt?.[localFileUri] ??
                    Date.now()),
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
                options.renewProvisionalAttachment ||
                !(folder.provisionalChildren ?? []).includes(localFileUri) ||
                folder.provisionalChildrenAttachedAt?.[localFileUri] ===
                  undefined
              ) {
                await this.folders.update(folder.id, {
                  provisionalChildren: [
                    ...new Set([
                      ...(folder.provisionalChildren ?? []),
                      localFileUri,
                    ]),
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
    options: { actorId?: string; initialDocument?: string } = {}
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

    const initialDocument =
      options.initialDocument ??
      (await this.operationLogStorage.read(record.operationLogRef)).document
    let view: ParsedOperationLog = parseOperationLog(initialDocument)
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
          runmeAuthorKind: comment.payload.author.kind,
          runmeAuthorSource: comment.payload.author.source,
          runmeAuthenticatedPrincipal:
            comment.payload.author.authenticated_principal,
          runmeActorId: operation?.actor_id,
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
            runmeAuthorKind: comment.payload.author.kind,
            runmeAuthorSource: comment.payload.author.source,
            runmeAuthenticatedPrincipal:
              comment.payload.author.authenticated_principal,
            runmeActorId: operation?.actor_id,
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
      author?: Attribution
    }
  ): Promise<DriveComment> {
    const actorId = input.actorId ?? (await getNotebookActorId(uri))
    const commentId = input.commentId ?? crypto.randomUUID()
    const author = normalizeAttribution(input.author, true)
    const payload: CommentAddPayload = {
      comment_id: commentId,
      thread_id: commentId,
      author: {
        principal_id: actorId,
        display_name: author.displayName,
        kind: author.kind,
        ...(author.source
          ? {
              source: author.source,
              authenticated_principal: author.authenticatedPrincipal,
            }
          : {}),
      },
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
    options: { actorId?: string; author?: Attribution } = {}
  ): Promise<DriveComment> {
    const { materialized } = await this.readMaterializedOperationLog(uri)
    const parent = materialized.comments.find(
      (comment) => comment.comment_id === parentCommentId
    )
    if (!parent) {
      throw new Error(`Operation-log comment ${parentCommentId} was not found`)
    }
    const actorId = options.actorId ?? (await getNotebookActorId(uri))
    const author = normalizeAttribution(options.author, true)
    const payload: CommentReplyPayload = {
      comment_id: crypto.randomUUID(),
      thread_id: parent.thread_id,
      parent_comment_id: parentCommentId,
      author: {
        principal_id: actorId,
        display_name: author.displayName,
        kind: author.kind,
        ...(author.source
          ? {
              source: author.source,
              authenticated_principal: author.authenticatedPrincipal,
            }
          : {}),
      },
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

  /** Append a durable accept/reject decision for an operation-log suggestion. */
  async reviewOperationLogSuggestion(
    uri: string,
    suggestionId: string,
    decision: SuggestionDecision,
    operationIds: string[],
    options: { actorId?: string } = {}
  ): Promise<void> {
    if (operationIds.length === 0) {
      throw new Error(`Suggestion ${suggestionId} has no operations to review`)
    }
    const payload: SuggestionReviewPayload = {
      suggestion_id: suggestionId,
      decision,
      operation_ids: [...new Set(operationIds)],
    }
    await this.appendOperationLogMutation(
      uri,
      'suggestion.review',
      payload as unknown as JsonValue,
      options.actorId,
      decision === 'reject' ? payload.operation_ids : undefined
    )
  }

  /** Capture a fixed pair after the caller flushes its mounted editor. */
  async createNotebookReview(
    uri: string,
    input: {
      title?: string
      baseReviewId?: string
      startRevisionId?: string
      endRevisionId?: string
      cellIds?: string[]
      author?: Attribution
    }
  ) {
    const { parsed } = await this.readMaterializedOperationLog(uri)
    const rounds = buildReviewRounds(parsed.operations)
    const base = input.baseReviewId
      ? rounds.find((round) => round.id === input.baseReviewId)
      : undefined
    if (input.baseReviewId && !base) throw new Error('Base review not found')
    if (input.baseReviewId && (input.startRevisionId || input.endRevisionId))
      throw new Error('Choose explicit revisions or baseReviewId, not both')
    if (Boolean(input.startRevisionId) !== Boolean(input.endRevisionId))
      throw new Error('Choose both start and end revisions')
    const revisions = buildNotebookRevisions(parsed.operations)
    const start = input.startRevisionId
      ? revisions.find((r) => r.id === input.startRevisionId)
      : undefined
    const end = input.endRevisionId
      ? revisions.find((r) => r.id === input.endRevisionId)
      : undefined
    if (input.startRevisionId && (!start || !end))
      throw new Error('Revision not found')
    if (start && end && !revisionFollows(start, end))
      throw new Error('End revision must be after start revision')
    const baseOperationIds = start?.operationIds ?? base?.headOperationIds ?? []
    const headOperationIds = end
      ? [...new Set([...baseOperationIds, ...end.operationIds])]
      : captureReviewRevision(parsed.operations)
    const startKey = revisionKey(parsed.operations, baseOperationIds)
    const endKey = revisionKey(parsed.operations, headOperationIds)
    if (startKey === endKey)
      throw new Error('End revision must be after start revision')
    const cellIds = normalizeReviewCellIds(
      input.cellIds,
      materializeRevision(parsed.operations, baseOperationIds),
      materializeRevision(parsed.operations, headOperationIds)
    )
    const identity = reviewIdentityKey(startKey, endKey, cellIds)
    const existing = rounds.find(
      (r) =>
        reviewIdentityKey(
          revisionKey(parsed.operations, r.baseOperationIds),
          revisionKey(parsed.operations, r.headOperationIds),
          r.cellIds
        ) === identity
    )
    if (existing) return existing
    // Same pair yields the same ID across tabs and offline replicas. Projection
    // verifies full endpoints and coalesces concurrent create records.
    const id = `review:${md5(identity)}`
    await this.appendOperationLogMutation(uri, 'review.create', {
      id,
      title: input.title?.trim() || `Round ${rounds.length + 1}`,
      baseOperationIds,
      headOperationIds,
      ...(cellIds ? { cellIds } : {}),
      ...(base ? { previousReviewId: base.id } : {}),
      author: normalizeAttribution(input.author, true),
    } as unknown as JsonValue)
    return (await this.listNotebookReviews(uri)).find(
      (round) => round.id === id
    )!
  }

  async listNotebookReviews(uri: string) {
    return buildReviewRounds(
      (await this.readMaterializedOperationLog(uri)).parsed.operations
    )
  }

  /** Names annotate existing revisions; they do not change the notebook or its date. */
  async listNotebookRevisions(uri: string) {
    return buildNotebookRevisions(
      (await this.readMaterializedOperationLog(uri)).parsed.operations
    )
  }

  async labelNotebookRevision(
    uri: string,
    input: {
      revisionId: string
      name: string
      description?: string
      author?: Attribution
    }
  ) {
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 200 ||
      (input.description !== undefined &&
        (typeof input.description !== 'string' ||
          input.description.length > 2000))
    )
      throw new Error(
        'Provide a revision name (up to 200 characters) and description (up to 2000 characters)'
      )
    const revision = (await this.listNotebookRevisions(uri)).find(
      (r) => r.id === input.revisionId
    )
    if (!revision) throw new Error('Revision not found')
    await this.appendOperationLogMutation(uri, 'revision.label', {
      revisionId: revision.id,
      operationIds: revision.operationIds,
      name: input.name.trim(),
      description: input.description ?? '',
      author: normalizeAttribution(input.author, true),
    } as unknown as JsonValue)
    return (await this.listNotebookRevisions(uri)).find(
      (r) => r.id === revision.id
    )!
  }

  /** Read-only preview uses exactly the selected revisions, never the live head. */
  async previewNotebookReview(
    uri: string,
    input: {
      startRevisionId: string
      endRevisionId: string
      cellIds?: string[]
    }
  ) {
    const { parsed } = await this.readMaterializedOperationLog(uri)
    const revisions = buildNotebookRevisions(parsed.operations)
    const start = revisions.find((r) => r.id === input.startRevisionId)
    const end = revisions.find((r) => r.id === input.endRevisionId)
    if (!start || !end) throw new Error('Revision not found')
    if (!revisionFollows(start, end))
      throw new Error('End revision must be after start revision')
    const before = materializeRevision(parsed.operations, start.operationIds)
    const after = materializeRevision(parsed.operations, end.operationIds)
    const cellIds = normalizeReviewCellIds(input.cellIds, before, after)
    const identity = reviewIdentityKey(
      JSON.stringify(start.changeIds),
      JSON.stringify(end.changeIds),
      cellIds
    )
    const existing = buildReviewRounds(parsed.operations).find(
      (r) =>
        reviewIdentityKey(
          revisionKey(parsed.operations, r.baseOperationIds),
          revisionKey(parsed.operations, r.headOperationIds),
          r.cellIds
        ) === identity
    )
    return {
      start,
      end,
      before,
      after,
      cellIds,
      diff: withCellReviewKeys(
        computeReviewDiff(before, after, cellIds),
        parsed.operations,
        start.operationIds,
        end.operationIds
      ),
      existingReviewId: existing?.id,
    }
  }

  /** Validate and undo under the same OPFS writer lock. Content operations and
   * the decision share a commit envelope so replicas never see a partial undo.
   */
  async decideNotebookReviewCell(
    uri: string,
    input: {
      reviewId: string
      cellId: string
      decision: 'accept' | 'undo'
      author?: Attribution
    }
  ) {
    if (!['accept', 'undo'].includes(input.decision))
      throw new Error('Invalid cell decision')
    const record = await this.files.get(uri)
    if (!record?.operationLogRef)
      throw new Error('Operation-log reference missing')
    const actorId = await getNotebookActorId(uri)
    let mutationCreated = false
    try {
      const stored = await this.operationLogStorage.appendTransaction(
        record.operationLogRef,
        async (document) => {
          const parsed = parseOperationLog(document)
          const rounds = buildReviewRounds(parsed.operations)
          const round = rounds.find((r) => r.id === input.reviewId)
          const row = round?.diff.cells.find(
            (r) => (r.compareCell ?? r.baseCell)?.refId === input.cellId
          )
          if (!round || !row || row.kind === 'unchanged')
            throw new Error('Changed cell not found in review scope')
          const prior = cellDecisionFor(row, rounds)
          if (prior?.decision === input.decision) return ''
          if (prior?.decision === 'undo')
            throw new Error(
              'These cell changes were already undone; select a new comparison'
            )
          const operations = [...parsed.operations]
          const firstSequence = highestActorSequence(operations, actorId) + 1
          const transactionId = `${actorId}:cell-review:${firstSequence}`
          const created: RunmeOperation[] = []
          if (input.decision === 'undo') {
            const headIds = new Set(round.headOperationIds)
            const head = materializeOperationLog(
              operations.filter((op) => headIds.has(op.op_id))
            )
            const current = materializeOperationLog(operations)
            const cellAt = (log: typeof head) =>
              log.notebook.cells.find((c) => c.cell_id === input.cellId) ?? null
            if (
              operations.some(
                (op) =>
                  !headIds.has(op.op_id) &&
                  op.kind.startsWith('cell.') &&
                  (op.payload as any).cell_id === input.cellId
              ) ||
              cellStateKey(cellAt(head)) !== cellStateKey(cellAt(current))
            )
              throw new Error(
                'Cell changed since the reviewed revision. Refresh and compare the latest revision before undoing.'
              )
            // Diff one cell only. Other cells, notebook metadata and concurrent
            // additions are not part of this mutation.
            const previous = cloneNotebook(round.after)
            const next = cloneNotebook(round.after)
            previous.cells = row.compareCell ? [row.compareCell] : []
            next.cells = row.baseCell ? [row.baseCell] : []
            const inverse = await buildOperationLogDiff({
              previous,
              next,
              observedOperations: operations,
              actorId,
              firstActorSequence: firstSequence,
            })
            const baseIds = new Set(round.baseOperationIds)
            const baseCell = materializeOperationLog(
              operations.filter((op) => baseIds.has(op.op_id))
            ).notebook.cells.find((c) => c.cell_id === input.cellId)
            const baseIndex = round.before.cells.findIndex(
              (c) => c.refId === input.cellId
            )
            const neighbors = current.notebook.cells.filter(
              (c) => c.cell_id !== input.cellId
            )
            const following = round.before.cells
              .slice(baseIndex + 1)
              .map((c) => c.refId)
            const rightId = following.find((id) =>
              neighbors.some((c) => c.cell_id === id)
            )
            const rightIndex = rightId
              ? neighbors.findIndex((c) => c.cell_id === rightId)
              : neighbors.length
            const restoredPosition =
              baseCell && (row.moved || !row.compareCell)
                ? allocatePositionBetween({
                    left: neighbors[rightIndex - 1]?.position ?? null,
                    right: neighbors[rightIndex]?.position ?? null,
                    actorId,
                    actorSequence: firstSequence,
                  })
                : baseCell?.position
            for (const op of inverse) {
              if (op.kind === 'cell.restore' && baseCell)
                (op.payload as any).position = restoredPosition
              op.transaction_id = transactionId
              created.push(op)
            }
            operations.push(...created)
            // A one-cell snapshot does not encode its surrounding position.
            if (
              baseCell &&
              row.compareCell &&
              (row.moved ||
                canonicalJson(baseCell.position as unknown as JsonValue) !==
                  canonicalJson(cellAt(head)!.position as unknown as JsonValue))
            ) {
              const move = createRunmeOperation({
                actorId,
                actorSequence: highestActorSequence(operations, actorId) + 1,
                dependencies: causalHeads(operations),
                knownOperations: operations,
                kind: 'cell.move',
                payload: {
                  cell_id: input.cellId,
                  position: restoredPosition,
                } as unknown as JsonValue,
                transactionId,
              })
              created.push(move)
              operations.push(move)
            }
          }
          const decision = createRunmeOperation({
            actorId,
            actorSequence: highestActorSequence(operations, actorId) + 1,
            dependencies: causalHeads(operations),
            knownOperations: operations,
            kind: 'review.cell_decision',
            payload: {
              ...input,
              author: normalizeAttribution(input.author, true),
            },
            transactionId,
          })
          created.push(decision)
          operations.push(decision)
          const commit = createRunmeOperation({
            actorId,
            actorSequence: highestActorSequence(operations, actorId) + 1,
            dependencies: causalHeads(operations),
            knownOperations: operations,
            kind: 'transaction.commit',
            payload: {
              transaction_id: transactionId,
              members: created.map((op) => op.op_id),
            },
          })
          created.push(commit)
          mutationCreated = true
          return (
            created
              .map((op) => canonicalJson(op as unknown as JsonValue))
              .join('\n') + '\n'
          )
        },
        {
          validate: (document) => {
            const parsed = parseOperationLog(document)
            materializeOperationLog(parsed.operations)
            buildReviewRounds(parsed.operations)
          },
        }
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
    } catch (error) {
      if (mutationCreated)
        throw new OperationLogMutationCommitUncertainError(
          uri,
          'review.cell_decision',
          error
        )
      throw error
    }
  }

  async submitNotebookReview(
    uri: string,
    input: {
      reviewId: string
      outcome: ReviewOutcome
      summary?: string
      author?: Attribution
    }
  ) {
    if (
      !(await this.listNotebookReviews(uri)).some(
        (round) => round.id === input.reviewId
      )
    )
      throw new Error('Review not found')
    if (!REVIEW_OUTCOMES.includes(input.outcome))
      throw new Error('Invalid review outcome')
    if (input.summary !== undefined && typeof input.summary !== 'string')
      throw new Error('Review summary must be text')
    await this.appendOperationLogMutation(uri, 'review.submit', {
      ...input,
      author: normalizeAttribution(input.author, true),
    } as unknown as JsonValue)
  }

  async linkNotebookReviewThread(
    uri: string,
    reviewId: string,
    commentId: string
  ) {
    if (
      !(await this.listNotebookReviews(uri)).some(
        (round) => round.id === reviewId
      )
    )
      throw new Error('Review not found')
    if (
      !(await this.listOperationLogComments(uri)).some(
        (comment) => comment.id === commentId
      )
    )
      throw new Error('Thread not found')
    await this.appendOperationLogMutation(uri, 'review.link_thread', {
      reviewId,
      commentId,
    })
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
    suppliedActorId?: string,
    reverts?: string[]
  ): Promise<void> {
    const record = await this.files.get(uri)
    if (!record?.operationLogRef) {
      throw new Error(`Operation-log reference missing for ${uri}`)
    }
    const actorId = suppliedActorId ?? (await getNotebookActorId(uri))
    let mutationCreated = false
    try {
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
            reverts,
          })
          mutationCreated = true
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
    } catch (error) {
      if (mutationCreated) {
        throw new OperationLogMutationCommitUncertainError(uri, kind, error)
      }
      throw error
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
      autoSync?: boolean
    } = {}
  ): Promise<NotebookStoreItem> {
    return this.createLocalFile(parentUri, name, {
      mimeType,
      content,
      legacyConversionAttempt: options.legacyConversionAttempt,
      autoSync: options.autoSync,
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
    const invokedAt = nowIsoString()
    const sourceRecord = await this.files.get(sourceUri)
    const sourceLockIdentity =
      sourceRecord && isDriveUri(sourceRecord.remoteId)
        ? `drive:${parseDriveItem(sourceRecord.remoteId).id}`
        : sourceUri
    const sourceLockKey = `legacy-conversion:${sourceLockIdentity}`
    return this.driveSyncCoordinator.runExclusive(sourceLockKey, () =>
      this.convertLegacyNotebookToRunmeExclusive(
        sourceUri,
        parentUri,
        invokedAt,
        sourceLockKey
      )
    )
  }

  private async convertLegacyNotebookToRunmeExclusive(
    sourceUri: string,
    parentUri: string | undefined,
    invokedAt: string,
    heldLockKey: string,
    sourceAlreadySynced = false
  ): Promise<NotebookStoreItem> {
    let sourceRecord = await this.files.get(sourceUri)
    if (!sourceRecord) {
      throw new Error(`Local notebook record not found for ${sourceUri}`)
    }
    const sourceFormat = detectNotebookFileFormat(sourceRecord.name)
    if (sourceFormat !== 'runme-json' && sourceFormat !== 'ipynb') {
      throw new Error('Only .json and .ipynb notebooks can be converted')
    }
    if (sourceRecord.conflict) {
      throw new Error(
        `Resolve the sync conflict before converting ${sourceRecord.name}`
      )
    }

    // Validate raw Drive JSON before normal synchronization can decode it into
    // the protobuf model and discard unknown fields. Conversion below reads it
    // again after sync so the produced copy still reflects the latest bytes.
    if (sourceFormat === 'runme-json' && isDriveUri(sourceRecord.remoteId)) {
      await convertLegacyNotebookFileToRunme(
        await this.driveStore.loadContent(sourceRecord.remoteId),
        sourceRecord.name
      )
    }

    if (
      !sourceAlreadySynced &&
      (isDriveUri(sourceRecord.remoteId) ||
        isDriveUri(sourceRecord.parentRemoteIdWhenCreated))
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
    if (sourceRecord.conflict) {
      throw new Error(
        `Resolve the sync conflict before converting ${sourceRecord.name}`
      )
    }
    if (isDriveUri(sourceRecord.remoteId)) {
      const canonicalLockKey = `legacy-conversion:drive:${parseDriveItem(sourceRecord.remoteId).id}`
      if (canonicalLockKey !== heldLockKey) {
        // A pending Drive create starts under its local URI. Retain that lock
        // while joining the stable Drive-ID lock so callers arriving after the
        // source upload cannot race destination-marker creation.
        return this.driveSyncCoordinator.runExclusive(canonicalLockKey, () =>
          this.convertLegacyNotebookToRunmeExclusive(
            sourceUri,
            parentUri,
            invokedAt,
            canonicalLockKey,
            true
          )
        )
      }
    }
    // DriveNotebookStore.load normalizes protobuf JSON with unknown fields
    // ignored. Read the raw bytes after sync rather than the normalized cache.
    const sourceContent =
      sourceFormat === 'runme-json' && isDriveUri(sourceRecord.remoteId)
        ? await this.driveStore.loadContent(sourceRecord.remoteId)
        : await this.loadContent(sourceUri)
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

    if (!isDriveUri(destinationParent.remoteId)) {
      const targetLockKey = `legacy-conversion-target:${destinationParentUri}:${converted.fileName}`
      return this.driveSyncCoordinator.runExclusive(targetLockKey, async () => {
        const currentParent = await this.folders.get(destinationParentUri)
        if (!currentParent) {
          throw new Error(`Parent folder not found for ${destinationParentUri}`)
        }
        for (const childUri of currentParent.children) {
          const child = childUri.startsWith('local://file/')
            ? await this.files.get(childUri)
            : undefined
          if (child?.name === converted.fileName) {
            throw new FilesystemEntryAlreadyExistsError(converted.fileName)
          }
        }
        return this.createContent(
          destinationParentUri,
          converted.fileName,
          converted.content,
          RUNME_OPERATION_LOG_MIME_TYPE
        )
      })
    }

    if (isDriveUri(destinationParent.remoteId) && originalGoogleDriveId) {
      const destinationDriveFolder = parseDriveItem(destinationParent.remoteId)
      const equivalentDestinationParents = await this.folders
        .filter((record) => {
          try {
            const candidate = parseDriveItem(record.remoteId)
            return (
              candidate.type === NotebookStoreItemType.Folder &&
              candidate.id === destinationDriveFolder.id
            )
          } catch {
            return false
          }
        })
        .toArray()
      const candidateChildUris = new Set(
        equivalentDestinationParents.flatMap((record) => record.children)
      )
      const unfinishedAttempts = await this.files
        .filter((record) => {
          const attempt = record.legacyConversionAttempt
          return Boolean(
            attempt &&
              (!attempt.completedAt || attempt.completedAt >= invokedAt) &&
              attempt.originalGoogleDriveId === originalGoogleDriveId &&
              detectNotebookFileFormat(record.name) === 'runme-operation-log'
          )
        })
        .toArray()
      for (const attempt of unfinishedAttempts) {
        candidateChildUris.add(attempt.id)
      }
      for (const childUri of candidateChildUris) {
        if (!childUri.startsWith('local://file/')) {
          continue
        }
        let child = await this.files.get(childUri)
        let attempt = child?.legacyConversionAttempt
        let pendingNotebook: parser_pb.Notebook | undefined
        let recoveredFromNotebookMetadata = false

        // Conversion provenance lives in the .runme document as well as the
        // local retry marker. Reconstruct the marker when this Drive sibling
        // was mirrored by a fresh browser profile or after IndexedDB was
        // cleared, so retrying conversion does not upload a duplicate.
        if (
          child &&
          !attempt &&
          !child.lastSyncError &&
          child.name === converted.fileName &&
          detectNotebookFileFormat(child.name) === 'runme-operation-log'
        ) {
          // A read failure is not evidence that the same-named file is
          // unrelated. Surface it so a retry can inspect the existing Drive
          // file instead of falling through and creating a duplicate.
          pendingNotebook = child.operationLogRef
            ? await this.loadOperationLogSnapshot(childUri)
            : isDriveUri(child.remoteId)
              ? decodeNotebookFile(
                  await this.driveStore.loadContent(child.remoteId),
                  child.name
                ).notebook
              : undefined
          if (
            pendingNotebook?.metadata[
              RunmeMetadataKey.OriginalGoogleDriveID
            ] === originalGoogleDriveId
          ) {
            if (!child.operationLogRef) {
              await this.syncFile(childUri)
              const syncedChild = await this.files.get(childUri)
              if (!syncedChild?.operationLogRef) {
                throw new Error(
                  `Operation-log reference missing for ${childUri} after sync`
                )
              }
              child = syncedChild
              pendingNotebook = await this.loadOperationLogSnapshot(childUri)
            }
            attempt = {
              originalGoogleDriveId,
              // The original conversion checksum is not embedded in the
              // document. Treat the recovered copy as current so conversion
              // never overwrites edits made only in the .runme target.
              sourceChecksum,
              // Keep the recovered marker unfinished until the final target
              // sync succeeds, so any failure is reusable by the next retry.
              completedAt: undefined,
            }
            await this.files.update(childUri, {
              legacyConversionAttempt: attempt,
            })
            child = { ...child, legacyConversionAttempt: attempt }
            recoveredFromNotebookMetadata = true
          }
        }
        const completedDuringInvocation = Boolean(
          attempt?.completedAt && attempt.completedAt >= invokedAt
        )
        const isActiveConversionAttempt = Boolean(
          attempt && !attempt.completedAt
        )
        const isCompletedMatchingConversion = Boolean(
          attempt?.completedAt &&
            attempt.sourceChecksum === sourceChecksum &&
            !child?.lastSyncError
        )
        if (
          !child ||
          (!isActiveConversionAttempt &&
            !completedDuringInvocation &&
            !isCompletedMatchingConversion &&
            !recoveredFromNotebookMetadata) ||
          attempt?.originalGoogleDriveId !== originalGoogleDriveId ||
          detectNotebookFileFormat(child.name) !== 'runme-operation-log' ||
          (child.name !== converted.fileName &&
            !isActiveConversionAttempt &&
            !completedDuringInvocation)
        ) {
          continue
        }
        pendingNotebook ??= await this.loadOperationLogSnapshot(childUri)
        if (
          pendingNotebook.metadata[RunmeMetadataKey.OriginalGoogleDriveID] !==
          originalGoogleDriveId
        ) {
          continue
        }

        const currentParent = await this.findParentFolder(childUri)
        if (
          !isDriveUri(child.remoteId) &&
          child.parentRemoteIdWhenCreated &&
          parseDriveItem(child.parentRemoteIdWhenCreated).id !==
            destinationDriveFolder.id
        ) {
          // The original create may already have committed before the local
          // remote ID was persisted. Reconcile it against the original parent
          // before changing folders, otherwise the retry could create a second
          // file in the destination folder.
          await this.completePendingDriveCreate(childUri, child)
          const recoveredChild = await this.files.get(childUri)
          if (!recoveredChild) {
            throw new Error(`Local notebook record not found for ${childUri}`)
          }
          child = recoveredChild
        }

        if (child.name !== converted.fileName) {
          await this.rename(childUri, converted.fileName)
          const renamedChild = await this.files.get(childUri)
          if (!renamedChild) {
            throw new Error(`Local notebook record not found for ${childUri}`)
          }
          child = renamedChild
        }

        if (!isDriveUri(child.remoteId)) {
          if (child.parentRemoteIdWhenCreated !== destinationParent.remoteId) {
            await this.files.update(childUri, {
              parentRemoteIdWhenCreated: destinationParent.remoteId,
            })
            child = {
              ...child,
              parentRemoteIdWhenCreated: destinationParent.remoteId,
            }
          }
        } else {
          let currentRemoteParent =
            currentParent && isDriveUri(currentParent.remoteId)
              ? currentParent.remoteId
              : undefined
          if (!currentRemoteParent) {
            currentRemoteParent = (
              await this.driveStore.getMetadata(child.remoteId)
            )?.parents?.[0]
          }
          if (!currentRemoteParent) {
            throw new Error(
              `Google Drive parent folder not found for ${child.remoteId}`
            )
          }
          if (
            parseDriveItem(currentRemoteParent).id !== destinationDriveFolder.id
          ) {
            if (currentParent) {
              await this.move(childUri, destinationParentUri)
            } else {
              await this.driveStore.move(
                child.remoteId,
                currentRemoteParent,
                destinationParent.remoteId
              )
            }
          }
        }

        if (attempt.sourceChecksum !== sourceChecksum) {
          if (!child.operationLogRef) {
            continue
          }
          const refreshed = await this.operationLogStorage.appendTransaction(
            child.operationLogRef,
            async (currentDocument) => {
              const currentLog = parseOperationLog(currentDocument)
              const currentNotebook = materializedLogToNotebook(
                materializeOperationLog(currentLog.operations)
              )
              const appendedOperations = await buildOperationLogDiff({
                previous: currentNotebook,
                next: converted.notebook,
                observedOperations: currentLog.operations,
                actorId: currentLog.header.created_by,
                firstActorSequence:
                  highestActorSequence(
                    currentLog.operations,
                    currentLog.header.created_by
                  ) + 1,
              })
              return appendedOperations.length === 0
                ? ''
                : `${appendedOperations
                    .map((operation) =>
                      canonicalJson(operation as unknown as JsonValue)
                    )
                    .join('\n')}\n`
            },
            { validate: (document) => void parseOperationLog(document) }
          )
          await this.files.update(childUri, {
            doc: '',
            md5Checksum: refreshed.checksum,
            operationLogRef: refreshed.ref,
            legacyConversionAttempt: {
              originalGoogleDriveId,
              sourceChecksum,
              completedAt: undefined,
            },
          })
          this.notifySync(childUri)
        }

        await this.attachDriveFileToFolder(destinationParent.remoteId, childUri)
        await this.syncFile(childUri)
        await this.attachDriveFileToFolder(
          destinationParent.remoteId,
          childUri,
          { renewProvisionalAttachment: true }
        )
        await this.files.update(childUri, {
          legacyConversionAttempt: {
            originalGoogleDriveId,
            sourceChecksum,
            completedAt: nowIsoString(),
          },
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
        autoSync: false,
      }
    )
    if (isDriveUri(destinationParent.remoteId)) {
      await this.attachDriveFileToFolder(
        destinationParent.remoteId,
        created.uri
      )
      await this.syncFile(created.uri)
      await this.attachDriveFileToFolder(
        destinationParent.remoteId,
        created.uri,
        { renewProvisionalAttachment: true }
      )
      await this.files.update(created.uri, {
        legacyConversionAttempt: originalGoogleDriveId
          ? {
              originalGoogleDriveId,
              sourceChecksum,
              completedAt: nowIsoString(),
            }
          : undefined,
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
      autoSync?: boolean
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

    if (isDriveBackedParent && options.autoSync !== false) {
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
    if (record.operationLogRef) this.enqueueIpynbSync(uri)

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

    if (file?.operationLogRef) this.enqueueIpynbSync(uri)
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
    this.enqueueIpynbSync(uri)
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

  /** Queue derived work independently: export failure cannot reject a source save. */
  private enqueueIpynbSync(uri: string): void {
    let subject = this.ipynbSyncSubjects.get(uri)
    if (!subject) {
      subject = new Subject<void>()
      subject.pipe(debounceTime(20_000)).subscribe(() => {
        void this.syncIpynbFile(uri).catch(() => undefined)
      })
      this.ipynbSyncSubjects.set(uri, subject)
    }
    subject.next()
  }

  /** Publish the latest committed .runme snapshot as an optional Drive sibling. */
  async syncIpynbFile(uri: string): Promise<void> {
    await this.driveSyncCoordinator.runExclusive(uri, async () => {
      try {
        const record = await this.files.get(uri)
        if (
          !record?.operationLogRef ||
          record.conflict ||
          !isDriveUri(record.remoteId)
        )
          return
        const document = (
          await this.operationLogStorage.read(record.operationLogRef)
        ).document
        const log = parseOperationLog(document)
        const notebook = materializedLogToNotebook(
          materializeOperationLog(log.operations)
        )
        if (notebook.metadata[AUTO_IPYNB_KEY] !== 'true') return
        const driveStore = appState.driveNotebookStore ?? this.driveStore
        const metadata = await driveStore.getMetadata(record.remoteId)
        const parentUri = metadata?.parents?.[0]
        if (!parentUri)
          throw new Error(
            'The source notebook needs a Drive parent folder to export a Colab copy.'
          )
        const name = `${(metadata.name || record.name).replace(/\.runme$/i, '')}.ipynb`
        // A source-scoped identity survives retries and independent local mirrors.
        // Never select an unrelated user file merely because its name matches.
        const sourceUri = driveFileUrl(parseDriveItem(record.remoteId).id)
        const target = await ensureDerivedCopy(
          driveStore,
          record.remoteId,
          parentUri,
          name,
          async () => {
            const beforeCreate = await this.files.get(uri)
            if (
              !beforeCreate?.operationLogRef ||
              beforeCreate.conflict ||
              beforeCreate.remoteId !== record.remoteId
            )
              return null
            const currentLog = parseOperationLog(
              (
                await this.operationLogStorage.read(
                  beforeCreate.operationLogRef
                )
              ).document
            )
            const currentNotebook = materializedLogToNotebook(
              materializeOperationLog(currentLog.operations)
            )
            if (currentNotebook.metadata[AUTO_IPYNB_KEY] !== 'true') return null
            return encodeDerivedIpynb(currentNotebook, {
              version: 1,
              uri: record.remoteId,
              notebookId: currentLog.header.notebook_id,
              generatedAt: new Date().toISOString(),
              operationIds: currentLog.operations.map((op) => op.op_id),
            })
          }
        )
        if (!target) return
        await this.files.update(uri, {
          ipynbExportUri: target.uri,
          ipynbExportSourceUri: sourceUri,
          ipynbExportPendingClaim: undefined,
        })
        // Capture the target version BEFORE reading inputs. Metadata and media
        // publish together after a client-side version recheck. The read/write
        // gap can still race; never retry known-stale bytes.
        const targetVersion = await driveStore.getVersionMetadata(target.uri)
        if (!targetVersion)
          throw new Error('Colab copy disappeared; retry sync.')
        const currentTarget = await driveStore.getMetadata(target.uri)
        const previousContent = await driveStore.loadContent(target.uri)
        let previousCopy
        try {
          previousCopy = JSON.parse(previousContent)
        } catch {
          // A create can commit metadata before its media upload fails. The
          // source marker was verified by ensureDerivedCopy; repair those bytes
          // under the captured version rather than strand the owned target.
          previousCopy = undefined
        }
        const sourceMetadata = await driveStore.getMetadata(record.remoteId)
        const currentParent = sourceMetadata?.parents?.[0]
        if (!currentParent)
          throw new Error('Source notebook has no Drive parent.')
        const currentName = `${(sourceMetadata.name || record.name).replace(/\.runme$/i, '')}.ipynb`
        const upstreamContent = await driveStore.loadContent(record.remoteId)
        // Re-read after network work so a disabled option cancels a queued export
        // and a newer local save supersedes the initially observed snapshot.
        const latest = await this.files.get(uri)
        if (
          !latest?.operationLogRef ||
          latest.conflict ||
          latest.remoteId !== record.remoteId
        )
          return
        const latestLog = parseOperationLog(
          (await this.operationLogStorage.read(latest.operationLogRef)).document
        )
        if (upstreamContent !== '') {
          const upstreamLog = parseOperationLog(upstreamContent)
          if (upstreamLog.header.notebook_id !== latestLog.header.notebook_id)
            throw new Error('Source notebook identity changed during export.')
          latestLog.operations = mergeOperationSets(
            latestLog.operations,
            upstreamLog.operations
          )
        }
        const operationIds = latestLog.operations.map((op) => op.op_id)
        const covered = new Set(operationIds)
        const previousIds =
          previousCopy?.metadata?.runme?.derivedFrom?.operationIds
        if (
          Array.isArray(previousIds) &&
          previousIds.some((id: string) => !covered.has(id))
        )
          throw new Error(
            'Colab copy contains newer changes. Sync the source notebook before exporting again.'
          )
        const latestNotebook = materializedLogToNotebook(
          materializeOperationLog(latestLog.operations)
        )
        if (latestNotebook.metadata[AUTO_IPYNB_KEY] !== 'true') return
        const generatedAt = new Date().toISOString()
        const published = await driveStore.saveContentAfterVersionCheck(
          target.uri,
          encodeDerivedIpynb(latestNotebook, {
            version: 1,
            uri: record.remoteId,
            notebookId: latestLog.header.notebook_id,
            generatedAt,
            operationIds,
          }),
          'application/x-ipynb+json',
          {
            checksum: targetVersion.md5Checksum,
            revisionId: targetVersion.headRevisionId,
            version: targetVersion.version,
          },
          {
            name: currentName,
            parentUri: currentParent,
            previousParentUri: currentTarget?.parents?.[0],
          }
        )
        if (!published) {
          this.enqueueIpynbSync(uri)
          throw new Error(
            'Colab copy changed during export; a fresh export is queued.'
          )
        }
        await this.files.update(uri, {
          ipynbExportError: undefined,
          ipynbExportedAt: generatedAt,
        })
      } catch (error) {
        await this.files.update(uri, {
          ipynbExportError: String(error),
          ipynbExportPendingClaim:
            error instanceof UnconfirmedDerivedCopyError
              ? error.claim
              : undefined,
        })
        appLogger.warn('Could not export Colab copy', {
          attrs: {
            scope: 'storage.local.ipynb-export',
            localUri: uri,
            error: String(error),
          },
        })
        throw error
      } finally {
        this.notifySync(uri)
      }
    })
  }

  /** Read export status separately from the primary notebook sync indicator. */
  async getIpynbExportState(uri: string): Promise<{
    uri?: string
    error?: string
    exportedAt?: string
    needsCreateRecovery?: boolean
  }> {
    const record = await this.files.get(uri)
    return {
      uri: record?.ipynbExportUri,
      error: record?.ipynbExportError,
      exportedAt: record?.ipynbExportedAt,
      needsCreateRecovery: Boolean(record?.ipynbExportPendingClaim),
    }
  }

  /** Explicit user recovery: never clear a newer claim or a confirmed copy. */
  async retryUnconfirmedIpynbCreation(uri: string): Promise<void> {
    await this.driveSyncCoordinator.runExclusive(uri, async () => {
      const record = await this.files.get(uri)
      if (!record?.ipynbExportPendingClaim || !isDriveUri(record.remoteId))
        return
      const drive = appState.driveNotebookStore ?? this.driveStore
      await drive.updateDerivedCopyClaimAfterCheck(
        record.remoteId,
        record.ipynbExportPendingClaim,
        null
      )
      await this.files.update(uri, {
        ipynbExportPendingClaim: undefined,
        ipynbExportError: undefined,
      })
    })
    await this.syncIpynbFile(uri)
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
          this.enqueueIpynbSync(localUri)
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

  /** Merge a raw .runme operation set with Drive using bounded client-side reconciliation. */
  private async syncOperationLogDrive(
    localUri: string,
    record: LocalFileRecord
  ): Promise<void> {
    if (!record.operationLogRef) {
      // Persist the seed before any upload, so a failed initial write does not
      // invent a second notebook identity on retry or lose its recovery state.
      let snapshot = null
      for (
        let attempt = 0;
        attempt < DRIVE_OPERATION_LOG_MERGE_ATTEMPTS;
        attempt += 1
      ) {
        snapshot = await this.loadConsistentDriveOperationLogSnapshot(
          record.remoteId
        )
        if (snapshot) break
      }
      if (!snapshot)
        throw new Error(
          `Drive operation log changed during ${DRIVE_OPERATION_LOG_MERGE_ATTEMPTS} merge attempts for ${localUri}`
        )
      const remote = parseOperationLog(
        snapshot.content || createInitialNotebookFile(record.name)
      )
      const stored = await this.operationLogStorage.initialize(
        localUri,
        serializeOperationLog(remote.header, remote.operations, {
          canonicalOrder: true,
        })
      )
      await this.files.update(localUri, {
        doc: '',
        operationLogRef: stored.ref,
        md5Checksum: stored.checksum,
      })
      record = { ...record, operationLogRef: stored.ref }
    }

    const recovery = new DriveRevisionRecovery(
      this.driveStore,
      record.remoteId,
      record.driveRecoveryCheckpoint,
      async (checkpoint) => {
        await this.files.update(localUri, {
          driveRecoveryCheckpoint: checkpoint,
        })
      }
    )
    for (
      let attempt = 0;
      attempt <= DRIVE_OPERATION_LOG_MERGE_ATTEMPTS;
      attempt += 1
    ) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(25 * 2 ** (attempt - 1), 200))
        )
      }
      if (!(await recovery.initialize())) continue
      const local = await this.operationLogStorage.read(record.operationLogRef!)
      const snapshot = await this.loadConsistentDriveOperationLogSnapshot(
        record.remoteId
      )
      if (!snapshot) continue
      const remoteContent = snapshot.content

      const localLog = parseOperationLog(local.document)
      // A zero-byte Drive file is an uninitialized upstream, not a malformed
      // operation log. Use the local header as its identity and force an
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
      const history = await recovery.collect(snapshot)
      let mergedOperations = mergeOperationSets(
        localLog.operations,
        remoteLog.operations
      )
      for (const content of history.contents) {
        const historical = parseOperationLog(content)
        if (historical.header.notebook_id !== localLog.header.notebook_id) {
          throw new Error(
            `Cannot recover a different operation-log notebook for ${localUri}; local operations remain pending.`
          )
        }
        mergedOperations = mergeOperationSets(
          mergedOperations,
          historical.operations
        )
      }
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
        stored = await this.operationLogStorage.append(
          local.ref,
          `${missingLocally
            .map((operation) =>
              canonicalJson(operation as unknown as JsonValue)
            )
            .join('\n')}\n`,
          { validate: (document) => void parseOperationLog(document) }
        )
      }

      await recovery.acknowledge(
        history.revisions,
        snapshot.version!.headRevisionId!
      )

      // append() may include another local writer's edits that arrived after
      // our read. Do not acknowledge those bytes as synced without uploading
      // their operations; re-read the durable journal on the next pass.
      const mergedIds = new Set(
        mergedOperations.map((operation) => operation.op_id)
      )
      if (
        parseOperationLog(stored.document).operations.some(
          (operation) => !mergedIds.has(operation.op_id)
        )
      )
        continue

      const mergedDocument = serializeOperationLog(
        localLog.header,
        mergedOperations,
        { canonicalOrder: true }
      )
      if (
        remoteWasEmpty ||
        mergedOperations.some((operation) => !remoteIds.has(operation.op_id))
      ) {
        // Reserve the last pass for verification after the eighth upload.
        if (attempt === DRIVE_OPERATION_LOG_MERGE_ATTEMPTS) break
        const saved = await this.driveStore.saveContentAfterVersionCheck(
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
        await recovery.uploaded(saved)
        // Always inspect history after a write, even when head equals our
        // upload: another writer may have been overwritten in the read/write gap.
        continue
      }
      const finalMetadata = await this.driveStore.getVersionMetadata(
        record.remoteId
      )
      if (!sameDriveVersion(snapshot.version, finalMetadata)) continue
      const version = driveMetadataToUpstreamVersion(finalMetadata)
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
