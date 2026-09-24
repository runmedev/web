import type LocalNotebooks from './local'

/** Bump whenever the wire contract or storage ownership assumptions change. */
export const STORAGE_OWNER_VERSION = 2
export const STORAGE_OWNER_NAME = 'runme-storage-owner'

/** Explicit RPC boundary: never expose arbitrary Dexie/prototype methods. */
export const STORAGE_METHODS = [
  'createDriveNotebookRequest',
  'addFile',
  'importTrustedDriveSnapshot',
  'attachDriveFileToFolder',
  'addNotebook',
  'initializeUploadedDriveNotebook',
  'reconcileDriveNotebook',
  'updateFolder',
  'sync',
  'getSyncState',
  'listFileSyncStatuses',
  'getMetadata',
  'save',
  'isOperationLogNotebook',
  'listOperationLogComments',
  'addOperationLogComment',
  'replyToOperationLogComment',
  'setOperationLogCommentResolved',
  'reviewOperationLogSuggestion',
  'listNotebookComparisons',
  'listNotebookRevisions',
  'checkpointNotebookRevision',
  'bindOperationLogCommentAnchors',
  'migrateNotebookToV2',
  'addAnchoredComment',
  'labelNotebookRevision',
  'previewNotebookComparison',
  'decideNotebookComparisonCell',
  'resolveOutputReference',
  'createOutputReference',
  'loadContent',
  'loadOperationLogSnapshot',
  'trainingExampleJob',
  'saveContent',
  'resolveConflictWithLocal',
  'refreshConflictWithLatestUpstream',
  'getConflictUpstreamDoc',
  'getDriveUpstreamDoc',
  'listDriveRevisions',
  'getDriveRevisionDoc',
  'load',
  'create',
  'createContent',
  'convertLegacyNotebookToRunme',
  'createFolder',
  'rename',
  'move',
  'moveToTrash',
  'syncMarkdownFile',
  'listDriveBackedFilesNeedingSync',
  'enqueueDriveBackedFilesNeedingSync',
  'reconcileDriveBackedFiles',
  'syncIpynbFile',
  'getIpynbExportState',
  'retryUnconfirmedIpynbCreation',
] as const satisfies readonly (keyof LocalNotebooks)[]

export type OwnerRequest = {
  type: 'request'
  version: number
  id: string
  method: string
  args: unknown[]
}

/** Structured clone does not preserve custom Error properties/prototypes. */
export function encodeStorageError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error))
    return { name: 'Error', message: String(error) }
  const fields: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  }
  for (const [key, value] of Object.entries(error)) {
    if (
      value === null ||
      ['string', 'number', 'boolean'].includes(typeof value)
    )
      fields[key] = value
  }
  return fields
}
