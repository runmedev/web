import type { NotebookTabState } from '../notebookDataController'
import type { NotebookOwnershipRecord } from '../tabCoordination/notebookOwnership'
import { isExcalidrawDocumentMetadata } from '../../storage/excalidraw'

export const DRIVE_LINK_STATUS_DOCUMENT_URI = 'status://drive-link'
export const DRIVE_SYNC_STATUS_DOCUMENT_URI = 'status://drive-sync'
export const VERSION_INFO_DOCUMENT_URI = 'app://version'
export const RUNNER_STATUS_DOCUMENT_URI = 'status://runners'
export const APP_CONSOLE_DOCUMENT_URI = 'app://console'
export const LOGS_DOCUMENT_URI = 'app://logs'

export interface WorkspaceDocument {
  uri: string
  title: string
  requestedUri?: string
  mimeType?: string
  state?: NotebookTabState
  readOnly?: boolean
  releasePending?: boolean
  writeAccessRequestState?: 'pending' | 'error'
  writeAccessErrorMessage?: string
  refreshErrorMessage?: string
  errorMessage?: string
  owner?: NotebookOwnershipRecord | null
}

export function getWorkspaceDocumentScheme(uri: string): string {
  const index = uri.indexOf(':')
  return index > 0 ? uri.slice(0, index) : ''
}

export function isNotebookDocumentUri(
  uri: string | null | undefined
): uri is string {
  return typeof uri === 'string' && uri.startsWith('local://file/')
}

export function isNotebookDiffUri(uri: string | null | undefined): boolean {
  return typeof uri === 'string' && uri.startsWith('diff://notebook/')
}

export function isExcalidrawWorkspaceDocument(
  document: Pick<WorkspaceDocument, 'title' | 'mimeType'> | null | undefined
): boolean {
  return isExcalidrawDocumentMetadata({
    name: document?.title,
    mimeType: document?.mimeType,
  })
}

export function isDriveLinkStatusUri(uri: string | null | undefined): boolean {
  return uri === DRIVE_LINK_STATUS_DOCUMENT_URI
}

export function isDriveSyncStatusUri(uri: string | null | undefined): boolean {
  return uri === DRIVE_SYNC_STATUS_DOCUMENT_URI
}

export function isVersionInfoUri(uri: string | null | undefined): boolean {
  return uri === VERSION_INFO_DOCUMENT_URI
}

export function isRunnerStatusUri(uri: string | null | undefined): boolean {
  return uri === RUNNER_STATUS_DOCUMENT_URI
}

export function isAppConsoleUri(uri: string | null | undefined): boolean {
  return uri === APP_CONSOLE_DOCUMENT_URI
}

export function isLogsUri(uri: string | null | undefined): boolean {
  return uri === LOGS_DOCUMENT_URI
}

export function isRestorableWorkspaceDocument(uri: string): boolean {
  return isNotebookDocumentUri(uri)
}

export function deriveWorkspaceDocumentTitle(uri: string): string {
  const documentUri = uri
  if (isDriveLinkStatusUri(documentUri)) {
    return 'Drive Link Status'
  }
  if (isDriveSyncStatusUri(documentUri)) {
    return 'Google Drive Sync Status'
  }
  if (isVersionInfoUri(documentUri)) {
    return 'Version Information'
  }
  if (isRunnerStatusUri(documentUri)) {
    return 'Notebook Runner Status'
  }
  if (isAppConsoleUri(documentUri)) {
    return 'App Console'
  }
  if (isLogsUri(documentUri)) {
    return 'Logs'
  }
  if (isNotebookDiffUri(documentUri)) {
    return 'Notebook diff'
  }
  try {
    const url = new URL(documentUri)
    const tail = url.pathname.split('/').filter(Boolean).pop()
    if (tail) {
      return decodeURIComponent(tail)
    }
  } catch {
    // Fall through to the URI segment heuristic.
  }
  return documentUri.split('/').filter(Boolean).pop() ?? documentUri
}
