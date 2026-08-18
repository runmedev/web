import md5 from 'md5'

import { parser_pb } from '../runme/client'
import { isDriveItemUri, parseDriveItem } from '../storage/drive'
import { NotebookStoreItemType } from '../storage/notebook'
import {
  LinkedResourceError,
  type LinkedResourcePresentationMode,
  type LinkedResourceV1,
  createLinkedResourceCell,
  parseLinkedResource,
} from './linkedResource'
import { recordLinkedResourceUploadFailure } from './linkedResourceMetrics'
import type { DriveResourceMetadata } from './linkedResourceStore'
import { ensurePersistentStorage } from './persistentStorage'
import { appState } from './runtime/AppState'
import type { NotebookDataLike } from './runtime/runmeConsole'

export type AttachResourceSource =
  | { kind: 'file'; value: File | Blob; name?: string }
  | { kind: 'drive'; uri: string }
  | { kind: 'url'; uri: string }

export type AttachResourceOptions = {
  target: { uri: string }
  folderUri?: string
  mode?: LinkedResourcePresentationMode
  title?: string
  altText?: string
  expectedRevision?: string
  operationId?: string
  signal?: AbortSignal
  onProgress?: (uploadedBytes: number, totalBytes: number) => void
}

export function pickResourceFromLocalFilesystem(): Promise<File | null> {
  if (typeof document === 'undefined') {
    throw new Error('Local file selection requires a browser document')
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*,video/*,audio/*,application/pdf,*/*'
    input.addEventListener(
      'change',
      () => {
        resolve(input.files?.[0] ?? null)
      },
      { once: true }
    )
    input.click()
  })
}

export class ResourceInsertionConflictError extends LinkedResourceError {
  constructor(
    readonly uploadedResource: DriveResourceMetadata,
    message = `The notebook changed before the uploaded resource could be inserted. The uploaded Drive file remains at ${uploadedResource.uri}.`
  ) {
    super('RESOURCE_CHANGED', message)
    this.name = 'ResourceInsertionConflictError'
  }
}

function notebookRevision(notebook: NotebookDataLike): string {
  return md5(
    JSON.stringify(notebook.getNotebook(), (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  )
}

function randomOperationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `resource-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
}

async function resolveDriveBackedNotebookUri(
  notebookUri: string
): Promise<string | null> {
  if (isDriveItemUri(notebookUri)) {
    return notebookUri
  }
  if (!notebookUri.startsWith('local://')) {
    return null
  }
  const metadata = await appState.localNotebooks?.getMetadata(notebookUri)
  return metadata?.remoteUri && isDriveItemUri(metadata.remoteUri)
    ? metadata.remoteUri
    : null
}

function resourceFromDriveMetadata(
  metadata: DriveResourceMetadata,
  options: AttachResourceOptions
): LinkedResourceV1 {
  return parseLinkedResource(
    JSON.stringify({
      version: 1,
      source: {
        provider: 'google-drive',
        uri: metadata.uri,
      },
      presentation: {
        mode: options.mode ?? 'auto',
        title: options.title,
        altText: options.altText,
      },
      hints: {
        name: metadata.name,
        mimeType: metadata.mimeType,
        sizeBytes: metadata.sizeBytes,
      },
    })
  )
}

function resourceFromHttpsUrl(
  uri: string,
  options: AttachResourceOptions
): LinkedResourceV1 {
  return parseLinkedResource(
    JSON.stringify({
      version: 1,
      source: { provider: 'https', uri },
      presentation: {
        mode: options.mode ?? 'link',
        title: options.title,
        altText: options.altText,
      },
    })
  )
}

export async function attachResourceToNotebook(
  notebook: NotebookDataLike,
  source: AttachResourceSource,
  options: AttachResourceOptions
): Promise<{
  uri: string
  cell: parser_pb.Cell
  resource: LinkedResourceV1
  uploadedResource?: DriveResourceMetadata
}> {
  if (!options?.target?.uri?.trim()) {
    throw new Error('notebooks.attach requires target: { uri }')
  }
  const notebookUri = notebook.getUri()
  if (notebookUri !== options.target.uri.trim()) {
    throw new Error(
      `Resolved notebook ${notebookUri} does not match target ${options.target.uri}`
    )
  }
  if (notebook.isReadOnly?.() || notebook.isReleasePending?.()) {
    throw new Error(`Notebook ${notebookUri} is read-only`)
  }
  const initialRevision = notebookRevision(notebook)
  if (
    options.expectedRevision &&
    options.expectedRevision !== initialRevision
  ) {
    throw new LinkedResourceError(
      'RESOURCE_CHANGED',
      `Notebook revision changed before attachment (${options.expectedRevision} -> ${initialRevision})`
    )
  }

  let resource: LinkedResourceV1
  let uploadedResource: DriveResourceMetadata | undefined
  if (source.kind === 'url') {
    resource = resourceFromHttpsUrl(source.uri, options)
  } else {
    const driveStore = appState.driveNotebookStore
    if (!driveStore) {
      throw new LinkedResourceError(
        'PROVIDER_UNAVAILABLE',
        'Google Drive storage is not initialized'
      )
    }
    if (source.kind === 'drive') {
      const metadata = await driveStore.getResourceMetadata(source.uri)
      resource = resourceFromDriveMetadata(metadata, options)
    } else {
      const driveNotebookUri = await resolveDriveBackedNotebookUri(notebookUri)
      let folderUri = options.folderUri
      if (!folderUri && driveNotebookUri) {
        folderUri = await driveStore.resolveAssetFolder(
          driveNotebookUri,
          notebook.getName()
        )
      }
      if (!folderUri) {
        throw new LinkedResourceError(
          'ACCESS_DENIED',
          'Choose a Google Drive folder before attaching a file to a local notebook'
        )
      }
      const folderType = await driveStore.getType(folderUri)
      if (folderType !== NotebookStoreItemType.Folder) {
        throw new Error('Resource upload destination must be a Drive folder')
      }
      const name =
        source.name ||
        (source.value instanceof File ? source.value.name : '') ||
        'attachment'
      try {
        uploadedResource = await driveStore.uploadResource(
          folderUri,
          name,
          source.value,
          {
            mimeType: source.value.type || 'application/octet-stream',
            operationId: options.operationId ?? randomOperationId(),
            appProperties: driveNotebookUri
              ? {
                  runmeNotebookFileId: parseDriveItem(driveNotebookUri).id,
                }
              : undefined,
            onProgress: options.onProgress,
            signal: options.signal,
          }
        )
      } catch (error) {
        recordLinkedResourceUploadFailure(error)
        throw error
      }
      await ensurePersistentStorage()
      resource = resourceFromDriveMetadata(uploadedResource, options)
    }
  }

  const currentRevision = notebookRevision(notebook)
  if (currentRevision !== initialRevision) {
    if (uploadedResource) {
      throw new ResourceInsertionConflictError(uploadedResource)
    }
    throw new LinkedResourceError(
      'RESOURCE_CHANGED',
      'The notebook changed before the resource could be inserted'
    )
  }
  if (!notebook.appendCell) {
    throw new Error('The target notebook does not support appending cells')
  }
  const inserted = notebook.appendCell(
    parser_pb.CellKind.CODE,
    'runme-resource'
  )
  const cell = createLinkedResourceCell(resource)
  cell.refId = inserted.refId
  notebook.updateCell(cell)
  try {
    await notebook.flushPendingPersist?.()
  } catch (error) {
    notebook.removeCell?.(cell.refId)
    if (uploadedResource) {
      throw new ResourceInsertionConflictError(
        uploadedResource,
        `The resource cell could not be saved. The uploaded Drive file remains at ${uploadedResource.uri}.`
      )
    }
    throw error
  }
  return {
    uri: notebookUri,
    cell,
    resource,
    uploadedResource,
  }
}
