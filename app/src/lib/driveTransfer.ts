import { create } from '@bufbuild/protobuf'
import md5 from 'md5'

import { RunmeMetadataKey, parser_pb } from '../runme/client'
import {
  DRIVE_CREATE_COMPLETED_CHECKSUM_PROPERTY,
  DRIVE_CREATE_EXPECTED_CHECKSUM_PROPERTY,
  DRIVE_CREATE_EXPECTED_REQUEST_PROPERTY,
  DriveCreateNotCommittedError,
  DriveFileCreatedError,
  type DriveSearchResult,
  driveFileUrl,
  driveFolderUrl,
  parseDriveItem,
} from '../storage/drive'
import { browserDriveSyncCoordinator } from '../storage/driveSyncCoordinator'
import type { UpstreamVersion } from '../storage/local'
import { NotebookStoreItemType } from '../storage/notebook'
import { IPYNB_MIME_TYPE } from './ipynb'
import { appLogger } from './logging/runtime'
import {
  decodeNotebookFile,
  detectNotebookFileFormat,
  encodeIpynbNotebook,
  encodeRunmeNotebook,
} from './notebookFormat'
import { appState } from './runtime/AppState'

function ensureDriveStore() {
  const store = appState.driveNotebookStore
  if (!store) {
    appLogger.error('Google Drive store is not initialized', {
      attrs: {
        scope: 'drive.transfer',
      },
    })
    throw new Error('Google Drive store is not initialized')
  }
  return store
}

function ensureLocalStore() {
  const store = appState.localNotebooks
  if (!store) {
    appLogger.error('Local notebook mirror store is not initialized', {
      attrs: {
        scope: 'drive.transfer',
      },
    })
    throw new Error('Local notebook mirror store is not initialized')
  }
  return store
}

export async function createDriveFile(
  folder: string,
  name: string
): Promise<string> {
  if (!folder?.trim()) {
    throw new Error('drive.create requires a Drive folder URI or folder id')
  }
  if (!name?.trim()) {
    throw new Error('drive.create requires a non-empty file name')
  }

  const folderRef = folder.includes('://')
    ? folder
    : `https://drive.google.com/drive/folders/${folder}`
  appLogger.info('Creating Google Drive file', {
    attrs: {
      scope: 'drive.transfer',
      folderRef,
      name,
    },
  })
  try {
    const created = await ensureDriveStore().create(folderRef, name)
    const { id } = parseDriveItem(created.uri)
    appLogger.info('Created Google Drive file', {
      attrs: {
        scope: 'drive.transfer',
        fileId: id,
        name,
      },
    })
    return id
  } catch (error) {
    appLogger.error('Failed to create Google Drive file', {
      attrs: {
        scope: 'drive.transfer',
        folderRef,
        name,
        error: String(error),
      },
    })
    throw error
  }
}

export async function listDriveFolderItems(folder: string) {
  if (!folder?.trim()) {
    throw new Error('drive.list requires a Drive folder URI or folder id')
  }

  const folderRef = folder.includes('://')
    ? folder
    : driveFolderUrl(folder.trim())

  appLogger.info('Listing Google Drive folder', {
    attrs: {
      scope: 'drive.transfer',
      folderRef,
    },
  })
  try {
    const items = await ensureDriveStore().list(folderRef)
    appLogger.info('Listed Google Drive folder items', {
      attrs: {
        scope: 'drive.transfer',
        folderRef,
        count: items.length,
      },
    })
    return items
  } catch (error) {
    appLogger.error('Failed to list Google Drive folder', {
      attrs: {
        scope: 'drive.transfer',
        folderRef,
        error: String(error),
      },
    })
    throw error
  }
}

/**
 * Executes a Google Drive files.list request through the authenticated Drive
 * store. The request remains unmodified so App Console and WebMCP callers can
 * use the complete Drive query grammar and list parameter surface.
 */
export async function searchDriveFiles(
  request: Record<string, unknown>
): Promise<DriveSearchResult> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error(
      'drive.search requires a Google Drive files.list request object'
    )
  }

  appLogger.info('Searching Google Drive files', {
    attrs: {
      scope: 'drive.transfer',
      hasQuery: typeof request.q === 'string' && request.q.length > 0,
      hasPageToken:
        typeof request.pageToken === 'string' && request.pageToken.length > 0,
    },
  })
  try {
    const result = await ensureDriveStore().search(request)
    appLogger.info('Searched Google Drive files', {
      attrs: {
        scope: 'drive.transfer',
        count: result.files.length,
        hasNextPage: Boolean(result.nextPageToken),
        incompleteSearch: result.incompleteSearch === true,
      },
    })
    return result
  } catch (error) {
    appLogger.error('Failed to search Google Drive files', {
      attrs: {
        scope: 'drive.transfer',
        error: String(error),
      },
    })
    throw error
  }
}

export type MountDriveFolderResult = {
  folderId: string
  name: string
  remoteUri: string
  localUri: string
  alreadyMounted: boolean
}

/**
 * Validate, mirror, and mount a Google Drive folder in the workspace explorer.
 * Mirroring before registration means callers only receive success after the
 * authenticated Drive request has proved that the folder is accessible.
 */
export async function mountDriveFolder(
  folder: string
): Promise<MountDriveFolderResult> {
  const remoteUri = canonicalDriveFolderRef(folder, 'drive.mountFolder')
  const { id: folderId } = parseDriveItem(remoteUri)

  appLogger.info('Mounting Google Drive folder', {
    attrs: {
      scope: 'drive.transfer',
      folderId,
    },
  })

  try {
    // Raw Drive IDs do not encode whether they identify a file or a folder.
    // Verify the provider metadata before creating any local mirror state.
    const remoteMetadata = await ensureDriveStore().getMetadata(remoteUri)
    if (remoteMetadata?.type !== NotebookStoreItemType.Folder) {
      throw new Error(
        'drive.mountFolder requires a Google Drive folder URI or folder id'
      )
    }

    const localStore = ensureLocalStore()
    const localUri = await localStore.updateFolder(
      remoteUri,
      remoteMetadata.name
    )
    const metadata = await localStore.getMetadata(localUri)
    const workspaceItems = appState.getWorkspaceItems()
    const alreadyMounted =
      workspaceItems.includes(localUri) || workspaceItems.includes(remoteUri)
    if (workspaceItems.includes(remoteUri) && remoteUri !== localUri) {
      // Older flows could register the remote URL before its local mirror was
      // available. Replace that transient representation with the stable URI.
      appState.removeWorkspaceItem(remoteUri)
    }
    appState.addWorkspaceItem(localUri)
    const name = metadata?.name?.trim() || folderId

    appLogger.info('Mounted Google Drive folder', {
      attrs: {
        scope: 'drive.transfer',
        folderId,
        localUri,
        alreadyMounted,
      },
    })

    return {
      folderId,
      name,
      remoteUri,
      localUri,
      alreadyMounted,
    }
  } catch (error) {
    appLogger.error('Failed to mount Google Drive folder', {
      attrs: {
        scope: 'drive.transfer',
        folderId,
        error: String(error),
      },
    })
    throw error
  }
}

export async function updateDriveFileBytes(
  idOrUri: string,
  bytes: Uint8Array | ArrayBuffer | ArrayLike<number>,
  mimeType: string = 'text/markdown'
): Promise<string> {
  if (!idOrUri?.trim()) {
    throw new Error('drive.update requires a Drive file id or URI')
  }
  const normalizedBytes =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes)

  const uri = idOrUri.includes('://') ? idOrUri : driveFileUrl(idOrUri)
  const content = new TextDecoder().decode(normalizedBytes)
  appLogger.info('Updating Google Drive file', {
    attrs: {
      scope: 'drive.transfer',
      uri,
      bytes: normalizedBytes.byteLength,
      mimeType,
    },
  })
  try {
    await ensureDriveStore().saveContent(uri, content, mimeType)
    const { id } = parseDriveItem(uri)
    appLogger.info('Updated Google Drive file', {
      attrs: {
        scope: 'drive.transfer',
        fileId: id,
        bytes: normalizedBytes.byteLength,
      },
    })
    return id
  } catch (error) {
    appLogger.error('Failed to update Google Drive file', {
      attrs: {
        scope: 'drive.transfer',
        uri,
        bytes: normalizedBytes.byteLength,
        mimeType,
        error: String(error),
      },
    })
    throw error
  }
}

export async function moveDriveFileToTrash(idOrUri: string) {
  if (!idOrUri?.trim()) {
    throw new Error('drive.trash requires a Drive file id or URI')
  }

  const uri = idOrUri.includes('://') ? idOrUri : driveFileUrl(idOrUri.trim())
  const item = parseDriveItem(uri)
  if (item.type !== NotebookStoreItemType.File) {
    throw new Error('drive.trash target must be a Drive file')
  }

  appLogger.info('Moving Google Drive file to trash', {
    attrs: {
      scope: 'drive.transfer',
      uri,
      fileId: item.id,
    },
  })
  try {
    const trashed = await ensureDriveStore().moveToTrash(uri)
    appLogger.info('Moved Google Drive file to trash', {
      attrs: {
        scope: 'drive.transfer',
        fileId: item.id,
      },
    })
    return trashed
  } catch (error) {
    appLogger.error('Failed to move Google Drive file to trash', {
      attrs: {
        scope: 'drive.transfer',
        uri,
        fileId: item.id,
        error: String(error),
      },
    })
    throw error
  }
}

type DriveNotebookCreationResult = {
  fileId: string
  fileName: string
  remoteUri: string
  localUri: string
}

const driveNotebookCreationFlights = new Map<
  string,
  { requestFingerprint: string; promise: Promise<DriveNotebookCreationResult> }
>()

type DurableDriveCreateAttempt = {
  fileName: string
  expectedChecksum: string
  createdAtMs: number
  remoteUri?: string
  creationRevisionId?: string
}

const DRIVE_CREATE_ATTEMPT_STORAGE_PREFIX = 'runme:drive-create-attempt:'

function driveCreateAttemptStorageKey(
  folderRef: string,
  persistedCreateOperationId: string
): string {
  return `${DRIVE_CREATE_ATTEMPT_STORAGE_PREFIX}${folderRef}:${persistedCreateOperationId}`
}

function readDriveCreateAttempt(key: string): {
  available: boolean
  attempt?: DurableDriveCreateAttempt
} {
  try {
    const storage = globalThis.localStorage
    if (!storage) {
      return { available: false }
    }
    const serialized = storage.getItem(key)
    if (!serialized) {
      return { available: true }
    }
    const parsed = JSON.parse(serialized) as Partial<DurableDriveCreateAttempt>
    if (
      typeof parsed.fileName !== 'string' ||
      typeof parsed.expectedChecksum !== 'string' ||
      typeof parsed.createdAtMs !== 'number' ||
      (parsed.remoteUri !== undefined &&
        typeof parsed.remoteUri !== 'string') ||
      (parsed.creationRevisionId !== undefined &&
        typeof parsed.creationRevisionId !== 'string')
    ) {
      return { available: true }
    }
    return { available: true, attempt: parsed as DurableDriveCreateAttempt }
  } catch {
    return { available: false }
  }
}

function writeDriveCreateAttempt(
  key: string,
  attempt: DurableDriveCreateAttempt
): boolean {
  try {
    const storage = globalThis.localStorage
    if (!storage) {
      return false
    }
    storage.setItem(key, JSON.stringify(attempt))
    return true
  } catch {
    return false
  }
}

function removeDriveCreateAttempt(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    // The original error remains authoritative if browser storage changed.
  }
}

function waitForDriveIndex(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function bestEffortCrossProfileSettlementDelay(remoteUri: string): number {
  let hash = 2166136261
  for (const character of remoteUri) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  // Unrelated browser profiles cannot share the durable reserved ID. Give
  // Drive's shared search index time to expose an earlier create so a later
  // profile can usually adopt it. This is deliberately best-effort: Drive has
  // no atomic uniqueness primitive for appProperties, so callers must not use
  // this delay as a cross-profile exactly-once guarantee.
  return 250 + ((hash >>> 0) % 4_000)
}

async function findIndexedDriveCreate(
  folderRef: string,
  persistedCreateOperationId: string
) {
  const driveStore = ensureDriveStore()
  for (const delayMs of [250, 500, 1_000, 2_000]) {
    await waitForDriveIndex(delayMs)
    const file = await driveStore.findByCreateOperation(
      folderRef,
      persistedCreateOperationId
    )
    if (file) {
      return file
    }
  }
  return null
}

function canonicalDriveFolderRef(folder: string, operation: string): string {
  const trimmed = folder.trim()
  if (!trimmed) {
    throw new Error(`${operation} requires a Drive folder URI or folder id`)
  }
  const candidate = trimmed.includes('://') ? trimmed : driveFolderUrl(trimmed)
  const item = parseDriveItem(candidate)
  if (item.type !== NotebookStoreItemType.Folder) {
    throw new Error(`${operation} requires a Drive folder URI or folder id`)
  }
  return driveFolderUrl(item.id)
}

/** Convert Drive parent IDs and share links into one canonical folder URI. */
function canonicalDriveParentRef(parent: string): string | undefined {
  try {
    const candidate = parent.includes('://') ? parent : driveFolderUrl(parent)
    const item = parseDriveItem(candidate)
    return item.type === NotebookStoreItemType.Folder
      ? driveFolderUrl(item.id)
      : undefined
  } catch {
    return undefined
  }
}

async function hashCreateOperationId(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

export async function saveNotebookAsDriveCopy(
  notebook: parser_pb.Notebook,
  folder: string,
  name: string,
  options: { createOperationId?: string } = {}
): Promise<DriveNotebookCreationResult> {
  if (!notebook) {
    throw new Error('drive.saveAsCurrentNotebook requires a notebook')
  }
  if (!folder?.trim()) {
    throw new Error(
      'drive.saveAsCurrentNotebook requires a Drive folder URI or folder id'
    )
  }
  if (!name?.trim()) {
    throw new Error(
      'drive.saveAsCurrentNotebook requires a non-empty file name'
    )
  }

  const folderRef = canonicalDriveFolderRef(
    folder,
    'drive.saveAsCurrentNotebook'
  )
  const format = detectNotebookFileFormat(name)
  if (!format) {
    throw new Error(
      'drive.saveAsCurrentNotebook file name must end in .json or .ipynb'
    )
  }
  const notebookJson =
    format === 'ipynb'
      ? encodeIpynbNotebook(notebook).text
      : encodeRunmeNotebook(notebook)
  const mimeType = format === 'ipynb' ? IPYNB_MIME_TYPE : 'application/json'
  const uploadedChecksum = md5(notebookJson)
  const createOperationId = options.createOperationId?.trim()
  const persistedCreateOperationIdPromise = createOperationId
    ? hashCreateOperationId(createOperationId)
    : Promise.resolve(undefined)
  const expectedRequestFingerprintPromise = createOperationId
    ? hashCreateOperationId(`${name}\u0000${uploadedChecksum}`)
    : Promise.resolve(undefined)

  const createOnce = async (): Promise<DriveNotebookCreationResult> => {
    const persistedCreateOperationId = await persistedCreateOperationIdPromise
    const expectedRequestFingerprint = await expectedRequestFingerprintPromise
    const driveStore = ensureDriveStore()
    const attemptStorageKey = persistedCreateOperationId
      ? driveCreateAttemptStorageKey(folderRef, persistedCreateOperationId)
      : undefined
    const durableAttempt = attemptStorageKey
      ? readDriveCreateAttempt(attemptStorageKey)
      : { available: false as const }
    if (attemptStorageKey && !durableAttempt.available) {
      throw new Error(
        'DRIVE_CREATE_RETRY_UNAVAILABLE: browser storage is required to create a Drive notebook safely'
      )
    }
    if (
      durableAttempt.attempt &&
      (durableAttempt.attempt.fileName !== name ||
        durableAttempt.attempt.expectedChecksum !== uploadedChecksum)
    ) {
      throw new Error(
        'IDEMPOTENCY_CONFLICT: Drive create operation was already used for different notebook input'
      )
    }
    const supportsReservedDriveId =
      typeof driveStore.generateFileId === 'function' &&
      typeof driveStore.getMetadataIfExists === 'function'
    const canReserveDriveId =
      supportsReservedDriveId &&
      (typeof driveStore.canUsePreGeneratedFileId !== 'function' ||
        (await driveStore.canUsePreGeneratedFileId(folderRef)))
    const canReadReservedDriveId =
      typeof driveStore.getMetadataIfExists === 'function' ||
      typeof driveStore.getMetadata === 'function'
    // Drive has no idempotency header for file creation. The operation and
    // request hashes are stored in private appProperties, while a generated
    // Drive id is persisted before mutation so a crash retry targets the same
    // file identity instead of issuing a second unconstrained create.
    let adoptedFile =
      durableAttempt.attempt?.remoteUri && canReadReservedDriveId
        ? typeof driveStore.getMetadataIfExists === 'function'
          ? await driveStore.getMetadataIfExists(
              durableAttempt.attempt.remoteUri
            )
          : await driveStore.getMetadata(durableAttempt.attempt.remoteUri)
        : persistedCreateOperationId
          ? await driveStore.findByCreateOperation(
              folderRef,
              persistedCreateOperationId
            )
          : null
    // Attempts without a stable Drive ID (legacy clients and Shared Drive
    // destinations) rely on the operation marker becoming searchable before
    // another create can be attempted.
    if (
      !adoptedFile &&
      persistedCreateOperationId &&
      durableAttempt.available &&
      durableAttempt.attempt &&
      !durableAttempt.attempt.remoteUri
    ) {
      adoptedFile = await findIndexedDriveCreate(
        folderRef,
        persistedCreateOperationId
      )
      if (!adoptedFile) {
        throw new Error(
          'DRIVE_CREATE_PENDING: a prior create attempt has not appeared in Drive search yet; retry later with the same idempotency key'
        )
      }
    }
    let reservedRemoteUri = durableAttempt.attempt?.remoteUri
    let createdFreshReservation = false
    if (attemptStorageKey && !adoptedFile && !reservedRemoteUri) {
      if (canReserveDriveId) {
        reservedRemoteUri = driveFileUrl(await driveStore.generateFileId())
        createdFreshReservation = true
      }
      const persisted = writeDriveCreateAttempt(attemptStorageKey, {
        fileName: name,
        expectedChecksum: uploadedChecksum,
        createdAtMs: Date.now(),
        ...(reservedRemoteUri ? { remoteUri: reservedRemoteUri } : {}),
      })
      if (!persisted) {
        throw new Error(
          'DRIVE_CREATE_RETRY_UNAVAILABLE: browser storage is required to create a Drive notebook safely'
        )
      }
    }
    if (
      !adoptedFile &&
      createdFreshReservation &&
      reservedRemoteUri &&
      persistedCreateOperationId &&
      typeof driveStore.waitForCreateOperation === 'function'
    ) {
      adoptedFile = await driveStore.waitForCreateOperation(
        folderRef,
        persistedCreateOperationId,
        bestEffortCrossProfileSettlementDelay(reservedRemoteUri)
      )
    }
    let createdFile = adoptedFile
    if (!createdFile) {
      try {
        createdFile = await driveStore.createContent(
          folderRef,
          name,
          notebookJson,
          mimeType,
          {
            ...(persistedCreateOperationId
              ? {
                  createOperationId: persistedCreateOperationId,
                  expectedContentChecksum: uploadedChecksum,
                  expectedRequestFingerprint,
                  ...(reservedRemoteUri
                    ? { fileId: parseDriveItem(reservedRemoteUri).id }
                    : {}),
                }
              : {}),
          }
        )
      } catch (error) {
        if (attemptStorageKey && error instanceof DriveFileCreatedError) {
          writeDriveCreateAttempt(attemptStorageKey, {
            fileName: name,
            expectedChecksum: uploadedChecksum,
            createdAtMs: durableAttempt.attempt?.createdAtMs ?? Date.now(),
            remoteUri: driveFileUrl(error.fileId),
            ...(error.creationRevisionId
              ? { creationRevisionId: error.creationRevisionId }
              : {}),
          })
        }
        if (
          attemptStorageKey &&
          !canReserveDriveId &&
          error instanceof DriveCreateNotCommittedError
        ) {
          removeDriveCreateAttempt(attemptStorageKey)
        }
        throw error
      }
    }
    const remoteUri = createdFile.uri
    if (attemptStorageKey) {
      writeDriveCreateAttempt(attemptStorageKey, {
        fileName: name,
        expectedChecksum: uploadedChecksum,
        createdAtMs: durableAttempt.attempt?.createdAtMs ?? Date.now(),
        remoteUri,
      })
    }
    const { id: fileId } = parseDriveItem(remoteUri)

    let upstreamContent = notebookJson
    let upstreamVersion: UpstreamVersion
    let metadata
    try {
      metadata = await driveStore.getVersionMetadata(remoteUri)
    } catch (error) {
      if (persistedCreateOperationId || adoptedFile) {
        throw error
      }
      // The upload already returned a concrete Drive file. A follow-up
      // metadata read is useful for revision tracking but is not required to
      // establish the initial mirror; failing here would invite a caller to
      // retry an otherwise successful non-idempotent create.
      appLogger.warn(
        'Drive metadata was unavailable after a successful notebook upload',
        {
          attrs: {
            scope: 'drive.transfer',
            remoteUri,
            error: String(error),
          },
        }
      )
      metadata = { md5Checksum: uploadedChecksum }
    }
    if (persistedCreateOperationId) {
      const expectedChecksum =
        metadata?.appProperties?.[DRIVE_CREATE_EXPECTED_CHECKSUM_PROPERTY]
      const expectedRequest =
        metadata?.appProperties?.[DRIVE_CREATE_EXPECTED_REQUEST_PROPERTY]
      const completedChecksum =
        metadata?.appProperties?.[DRIVE_CREATE_COMPLETED_CHECKSUM_PROPERTY]
      if (
        (expectedChecksum && expectedChecksum !== uploadedChecksum) ||
        (expectedRequest && expectedRequest !== expectedRequestFingerprint) ||
        (completedChecksum && completedChecksum !== uploadedChecksum)
      ) {
        throw new Error(
          'IDEMPOTENCY_CONFLICT: Drive create operation was already used for different notebook input'
        )
      }

      if (completedChecksum !== uploadedChecksum) {
        if (metadata?.md5Checksum !== uploadedChecksum) {
          const incomplete = await loadStableDriveContent(remoteUri)
          if (
            incomplete.content !== '' ||
            !durableAttempt.attempt?.creationRevisionId ||
            incomplete.version.revisionId !==
              durableAttempt.attempt.creationRevisionId
          ) {
            throw new Error(
              `IDEMPOTENCY_CONFLICT: Drive notebook changed before creation completed: ${remoteUri}`
            )
          }
          const repaired = await driveStore.saveContentIfVersion(
            remoteUri,
            notebookJson,
            mimeType,
            incomplete.version
          )
          if (!repaired) {
            throw new Error(
              `IDEMPOTENCY_CONFLICT: Drive notebook changed while creation was being repaired: ${remoteUri}`
            )
          }
        }
        const stable = await loadStableDriveContent(remoteUri)
        if (stable.version.checksum !== uploadedChecksum) {
          throw new Error(
            `Google Drive notebook upload did not match its intended content: ${remoteUri}`
          )
        }
        await driveStore.markCreateOperationComplete(
          remoteUri,
          uploadedChecksum
        )
        upstreamContent = stable.content
        upstreamVersion = stable.version
      } else {
        // A completed file may have legitimate later edits. Adopt its current
        // stable revision without replaying the original upload.
        const stable = await loadStableDriveContent(remoteUri)
        upstreamContent = stable.content
        upstreamVersion = stable.version
      }
    } else if (!adoptedFile && metadata?.md5Checksum === uploadedChecksum) {
      upstreamVersion = {
        checksum: uploadedChecksum,
        revisionId: metadata.headRevisionId,
      }
    } else {
      const stable = await loadStableDriveContent(remoteUri)
      upstreamContent = stable.content
      upstreamVersion = stable.version
    }

    const baselineNotebook =
      upstreamContent === notebookJson
        ? notebook
        : decodeNotebookFile(upstreamContent, createdFile.name ?? name).notebook

    const localStore = ensureLocalStore()
    const fileName = createdFile.name ?? name
    const localUri = await localStore.addFile(remoteUri, fileName, { mimeType })
    const attachmentParent =
      createdFile.parents === undefined
        ? folderRef
        : createdFile.parents
            .map(canonicalDriveParentRef)
            .find((parentUri): parentUri is string => Boolean(parentUri))
    if (attachmentParent) {
      await localStore.attachDriveFileToFolder?.(attachmentParent, localUri)
    }
    const initialized = await localStore.initializeUploadedDriveNotebook(
      localUri,
      baselineNotebook,
      upstreamContent,
      upstreamVersion
    )
    if (!initialized) {
      await localStore.reconcileDriveNotebook(localUri)
    }

    try {
      await appState.openNotebook(localUri)
    } catch (error) {
      appLogger.error(
        'Saved Drive copy but failed to switch current notebook',
        {
          attrs: {
            scope: 'drive.transfer',
            localUri,
            remoteUri,
            error: String(error),
          },
        }
      )
      throw error
    }

    appLogger.info(
      'Saved notebook as Google Drive copy and switched current doc',
      {
        attrs: {
          scope: 'drive.transfer',
          fileId,
          fileName,
          localUri,
          remoteUri,
        },
      }
    )
    return {
      fileId,
      fileName,
      remoteUri,
      localUri,
    }
  }

  if (!createOperationId) {
    return createOnce()
  }

  // Use the caller's key for the in-memory lock so the operation is reserved
  // before the asynchronous SHA-256 digest completes.
  const flightKey = `${folderRef}\u0000${createOperationId}`
  const requestFingerprint = `${name}\u0000${uploadedChecksum}`
  const active = driveNotebookCreationFlights.get(flightKey)
  if (active) {
    if (active.requestFingerprint !== requestFingerprint) {
      throw new Error(
        'IDEMPOTENCY_CONFLICT: concurrent Drive create calls used the same key for different notebook input'
      )
    }
    return active.promise
  }

  const promise = persistedCreateOperationIdPromise.then(
    (persistedCreateOperationId) =>
      browserDriveSyncCoordinator.runExclusive(
        // Web Locks coordinate the lookup-and-create transaction across tabs
        // and workers. The canonical folder keeps equal caller inputs on the
        // same lock, while the persisted operation hash keeps the name short.
        `create:${folderRef}:${persistedCreateOperationId}`,
        createOnce
      )
  )
  driveNotebookCreationFlights.set(flightKey, { requestFingerprint, promise })
  try {
    return await promise
  } finally {
    const current = driveNotebookCreationFlights.get(flightKey)
    if (current?.promise === promise) {
      driveNotebookCreationFlights.delete(flightKey)
    }
  }
}

/**
 * Read a Drive file only when its surrounding version metadata agrees with the
 * bytes. This prevents a concurrent edit from being recorded as the baseline
 * for different content.
 */
async function loadStableDriveContent(
  remoteUri: string
): Promise<{ content: string; version: UpstreamVersion }> {
  const driveStore = ensureDriveStore()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await driveStore.getVersionMetadata(remoteUri)
    const content = await driveStore.loadContent(remoteUri)
    const after = await driveStore.getVersionMetadata(remoteUri)
    const contentChecksum = md5(content)
    const beforeVersion = `${before?.md5Checksum ?? ''}:${before?.headRevisionId ?? ''}`
    const afterVersion = `${after?.md5Checksum ?? ''}:${after?.headRevisionId ?? ''}`
    if (
      beforeVersion === afterVersion &&
      after?.md5Checksum === contentChecksum
    ) {
      return {
        content,
        version: {
          checksum: contentChecksum,
          revisionId: after.headRevisionId,
        },
      }
    }
  }
  throw new Error(
    `Google Drive notebook changed while establishing its sync baseline: ${remoteUri}`
  )
}

/** Create one Drive-backed notebook and open its local editable mirror. */
export async function createDriveNotebook(
  folder: string,
  name: string,
  options: {
    cells?: Array<{
      kind: 'code' | 'markup'
      languageId?: string
      value?: string
      metadata?: Record<string, string>
    }>
    idempotencyKey?: string
  } = {}
): Promise<{
  fileId: string
  fileName: string
  remoteUri: string
  localUri: string
}> {
  if (!folder?.trim()) {
    throw new Error(
      'drive.createNotebook requires a Drive folder URI or folder id'
    )
  }
  if (!name?.trim()) {
    throw new Error('drive.createNotebook requires a non-empty file name')
  }
  if (!detectNotebookFileFormat(name)) {
    throw new Error(
      'drive.createNotebook file name must end in .json or .ipynb'
    )
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('drive.createNotebook options must be an object')
  }
  if (options.cells !== undefined && !Array.isArray(options.cells)) {
    throw new Error('drive.createNotebook options.cells must be an array')
  }
  if (
    options.idempotencyKey !== undefined &&
    (typeof options.idempotencyKey !== 'string' ||
      !options.idempotencyKey.trim() ||
      options.idempotencyKey.length > 128)
  ) {
    throw new Error(
      'drive.createNotebook options.idempotencyKey must be a non-empty string of at most 128 characters'
    )
  }
  const idempotencyKey = options.idempotencyKey?.trim()
  const deterministicCellIds = idempotencyKey
    ? await Promise.all(
        (options.cells ?? []).map((_cell, index) =>
          hashCreateOperationId(`${idempotencyKey}\u0000cell\u0000${index}`)
        )
      )
    : []
  const generatedAt = idempotencyKey ? undefined : new Date().toISOString()
  const cells = (options.cells ?? []).map((cell, index) => {
    if (!cell || (cell.kind !== 'code' && cell.kind !== 'markup')) {
      throw new Error(
        `drive.createNotebook cells[${index}].kind must be "code" or "markup"`
      )
    }
    if (cell.languageId !== undefined && typeof cell.languageId !== 'string') {
      throw new Error(
        `drive.createNotebook cells[${index}].languageId must be a string`
      )
    }
    if (cell.value !== undefined && typeof cell.value !== 'string') {
      throw new Error(
        `drive.createNotebook cells[${index}].value must be a string`
      )
    }
    if (
      cell.metadata !== undefined &&
      (!cell.metadata ||
        typeof cell.metadata !== 'object' ||
        Array.isArray(cell.metadata) ||
        Object.values(cell.metadata).some((value) => typeof value !== 'string'))
    ) {
      throw new Error(
        `drive.createNotebook cells[${index}].metadata must contain only string values`
      )
    }
    const isMarkup = cell.kind === 'markup'
    return create(parser_pb.CellSchema, {
      refId:
        deterministicCellIds[index]?.slice(0, 32) ??
        crypto.randomUUID().replace(/-/g, ''),
      kind: isMarkup ? parser_pb.CellKind.MARKUP : parser_pb.CellKind.CODE,
      role: parser_pb.CellRole.USER,
      languageId: cell.languageId?.trim() || (isMarkup ? 'markdown' : ''),
      value: cell.value ?? '',
      metadata: {
        ...cell.metadata,
        ...(generatedAt
          ? {
              [RunmeMetadataKey.CreatedAt]: generatedAt,
              [RunmeMetadataKey.UpdatedAt]: generatedAt,
            }
          : {}),
      },
    })
  })
  return saveNotebookAsDriveCopy(
    create(parser_pb.NotebookSchema, { cells, metadata: {} }),
    folder,
    name,
    { createOperationId: idempotencyKey }
  )
}

export async function copyDriveNotebookFile(
  sourceIdOrUri: string,
  targetFolder: string,
  targetName?: string
): Promise<{
  fileId: string
  fileName: string
  sourceUri: string
  targetUri: string
}> {
  if (!sourceIdOrUri?.trim()) {
    throw new Error('drive.copyNotebook requires a Drive file id or URI')
  }
  if (!targetFolder?.trim()) {
    throw new Error(
      'drive.copyNotebook requires a target Drive folder URI or folder id'
    )
  }

  const sourceUri = sourceIdOrUri.includes('://')
    ? sourceIdOrUri
    : driveFileUrl(sourceIdOrUri.trim())
  const targetFolderRef = targetFolder.includes('://')
    ? targetFolder
    : driveFolderUrl(targetFolder.trim())

  const sourceItem = parseDriveItem(sourceUri)
  if (sourceItem.type !== NotebookStoreItemType.File) {
    throw new Error('drive.copyNotebook source must be a Drive file')
  }
  const destinationFolderItem = parseDriveItem(targetFolderRef)
  if (destinationFolderItem.type !== NotebookStoreItemType.Folder) {
    throw new Error('drive.copyNotebook target must be a Drive folder')
  }

  appLogger.info('Copying Google Drive notebook file', {
    attrs: {
      scope: 'drive.transfer',
      sourceUri,
      targetFolderRef,
    },
  })

  try {
    const store = ensureDriveStore()
    const metadata = await store.getMetadata(sourceUri)
    if (!metadata || metadata.type !== NotebookStoreItemType.File) {
      throw new Error(
        'drive.copyNotebook source metadata is missing or not a file'
      )
    }

    const fileName = targetName?.trim() || metadata.name?.trim()
    if (!fileName) {
      throw new Error('drive.copyNotebook requires a non-empty file name')
    }

    const sourceFormat = detectNotebookFileFormat(metadata.name)
    const targetFormat = detectNotebookFileFormat(fileName)
    let sourceNotebook: parser_pb.Notebook
    let sourceIpynb: string | undefined
    if (sourceFormat === 'ipynb') {
      sourceIpynb = await store.loadContent(sourceUri)
      sourceNotebook = decodeNotebookFile(sourceIpynb, metadata.name).notebook
    } else {
      sourceNotebook = await store.load(sourceUri)
    }

    let created
    if (targetFormat === 'ipynb') {
      const content = sourceIpynb ?? encodeIpynbNotebook(sourceNotebook).text
      created = await store.createContent(
        targetFolderRef,
        fileName,
        content,
        IPYNB_MIME_TYPE
      )
    } else {
      created = await store.create(targetFolderRef, fileName)
      const saveResult = await store.save(created.uri, sourceNotebook)
      if (saveResult?.conflicted) {
        throw new Error('drive.copyNotebook failed due to save conflict')
      }
    }

    const { id: fileId } = parseDriveItem(created.uri)
    appLogger.info('Copied Google Drive notebook file', {
      attrs: {
        scope: 'drive.transfer',
        sourceUri,
        targetUri: created.uri,
        fileId,
        fileName,
      },
    })
    return {
      fileId,
      fileName,
      sourceUri,
      targetUri: created.uri,
    }
  } catch (error) {
    appLogger.error('Failed to copy Google Drive notebook file', {
      attrs: {
        scope: 'drive.transfer',
        sourceUri,
        targetFolderRef,
        error: String(error),
      },
    })
    throw error
  }
}
