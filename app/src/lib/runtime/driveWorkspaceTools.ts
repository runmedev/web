import { driveFolderUrl, parseDriveItem } from '../../storage/drive'
import { NotebookStoreItemType } from '../../storage/notebook'
import {
  inspectDriveItemAccess,
  mountDriveFolder,
  searchDriveFiles,
} from '../driveTransfer'

type JsonRecord = Record<string, unknown>

const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const DRIVE_RESULT_FIELDS =
  'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,driveId,createdTime,modifiedTime,webViewLink)'

export const SEARCH_DRIVE_ITEMS_TOOL_NAME = 'searchDriveItems'
export const SEARCH_DRIVE_ITEMS_TOOL_TITLE = 'Search Google Drive Items'
export const SEARCH_DRIVE_ITEMS_TOOL_DESCRIPTION =
  'Search accessible Google Drive files and folders by name. Use this before mounting when the user gives a folder name instead of an ID or URL. Prefer itemType "folder" and exactName true for a quoted folder name. Do not mount when multiple candidates remain; return them so the user or agent can disambiguate.'

export const LIST_DRIVE_FOLDER_TOOL_NAME = 'listDriveFolder'
export const LIST_DRIVE_FOLDER_TOOL_TITLE = 'List Google Drive Folder'
export const LIST_DRIVE_FOLDER_TOOL_DESCRIPTION =
  'List one bounded page of children in an accessible Google Drive folder. Use this to inspect a known folder or disambiguate search results without mounting it.'

export const INSPECT_DRIVE_ITEM_ACCESS_TOOL_NAME = 'inspectDriveItemAccess'
export const INSPECT_DRIVE_ITEM_ACCESS_TOOL_TITLE =
  'Inspect Google Drive Item Access'
export const INSPECT_DRIVE_ITEM_ACCESS_TOOL_DESCRIPTION =
  'Read aggregate sharing and capability facts for a Google Drive file or folder without returning collaborator names, emails, or domains. Before copying sensitive-looking content into a Drive notebook, inspect the destination folder. A result with visibility "private", publiclyAccessible false, and domainAccessible false is evidence that Runme is persisting within the signed-in user\'s restricted storage boundary; it does not change permissions or independently override Browser policy.'

export const MOUNT_DRIVE_FOLDER_TOOL_NAME = 'mountDriveFolder'
export const MOUNT_DRIVE_FOLDER_TOOL_TITLE = 'Mount Google Drive Folder'
export const MOUNT_DRIVE_FOLDER_TOOL_DESCRIPTION =
  'Validate, mirror, and add a specific Google Drive folder to the Runme workspace explorer. Pass only a folder ID or folder URL selected from user input or an unambiguous search result. The operation is idempotent for an already-mounted folder.'

/** Escape user text before embedding it in the Google Drive query grammar. */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** Convert a raw folder ID or folder URL into its canonical URI and ID. */
function parseFolderReference(folder: unknown, operation: string) {
  if (typeof folder !== 'string' || !folder.trim()) {
    throw new Error(`${operation} requires a Google Drive folder ID or URI`)
  }
  const candidate = folder.includes('://')
    ? folder.trim()
    : driveFolderUrl(folder.trim())
  const item = parseDriveItem(candidate)
  if (item.type !== NotebookStoreItemType.Folder) {
    throw new Error(`${operation} requires a Google Drive folder ID or URI`)
  }
  return {
    id: item.id,
    uri: driveFolderUrl(item.id),
  }
}

/** Normalize the bounded page controls shared by direct Drive read tools. */
function pageControls(input: JsonRecord) {
  const requestedPageSize = input.pageSize
  if (
    requestedPageSize !== undefined &&
    (typeof requestedPageSize !== 'number' ||
      !Number.isInteger(requestedPageSize) ||
      requestedPageSize < 1 ||
      requestedPageSize > MAX_PAGE_SIZE)
  ) {
    throw new Error(
      `Drive pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`
    )
  }
  const pageSize =
    requestedPageSize === undefined
      ? DEFAULT_PAGE_SIZE
      : (requestedPageSize as number)
  if (input.pageToken !== undefined && typeof input.pageToken !== 'string') {
    throw new Error('Drive pageToken must be a string')
  }
  const pageToken =
    typeof input.pageToken === 'string' && input.pageToken
      ? input.pageToken
      : undefined
  return { pageSize, pageToken }
}

/** Describe name-based Drive discovery without exposing raw query injection. */
export function buildSearchDriveItemsInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        description: 'File or folder name to search for.',
      },
      itemType: {
        type: 'string',
        enum: ['any', 'file', 'folder'],
        default: 'any',
        description: 'Restrict matches to files, folders, or either.',
      },
      exactName: {
        type: 'boolean',
        default: false,
        description:
          'Match the complete name instead of searching for a contained phrase.',
      },
      parentFolderIdOrUri: {
        type: 'string',
        minLength: 1,
        description:
          'Optional parent folder ID or URI used to scope the search.',
      },
      pageSize: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_PAGE_SIZE,
        default: DEFAULT_PAGE_SIZE,
      },
      pageToken: {
        type: 'string',
        minLength: 1,
        description: 'Opaque token returned by the previous page.',
      },
    },
    required: ['name'],
  }
}

/** Describe bounded folder traversal for a known Drive folder. */
export function buildListDriveFolderInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      folderIdOrUri: {
        type: 'string',
        minLength: 1,
        description: 'Google Drive folder ID or folder URI.',
      },
      pageSize: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_PAGE_SIZE,
        default: DEFAULT_PAGE_SIZE,
      },
      pageToken: {
        type: 'string',
        minLength: 1,
        description: 'Opaque token returned by the previous page.',
      },
    },
    required: ['folderIdOrUri'],
  }
}

/** Describe aggregate access inspection for a known Drive item. */
export function buildInspectDriveItemAccessInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      itemIdOrUri: {
        type: 'string',
        minLength: 1,
        description: 'Google Drive file/folder ID or URI.',
      },
      itemType: {
        type: 'string',
        enum: ['file', 'folder'],
        default: 'folder',
        description:
          'How to interpret a raw ID. A full Drive URI determines its own type.',
      },
    },
    required: ['itemIdOrUri'],
  }
}

/** Describe the explicit state-changing step after Drive discovery. */
export function buildMountDriveFolderInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      folderIdOrUri: {
        type: 'string',
        minLength: 1,
        description:
          'Google Drive folder ID or folder URI from the user or an unambiguous search result.',
      },
    },
    required: ['folderIdOrUri'],
  }
}

/** Execute a safe name-based Drive files.list request. */
export async function executeSearchDriveItems(
  input: JsonRecord
): Promise<string> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) {
    throw new Error('searchDriveItems requires a non-empty name')
  }
  if (
    input.itemType !== undefined &&
    input.itemType !== 'any' &&
    input.itemType !== 'file' &&
    input.itemType !== 'folder'
  ) {
    throw new Error('searchDriveItems itemType must be any, file, or folder')
  }
  if (input.exactName !== undefined && typeof input.exactName !== 'boolean') {
    throw new Error('searchDriveItems exactName must be a boolean')
  }

  const escapedName = escapeDriveQueryValue(name)
  const predicates = [
    input.exactName === true
      ? `name = '${escapedName}'`
      : `name contains '${escapedName}'`,
    'trashed = false',
  ]
  if (input.itemType === 'folder') {
    predicates.push(`mimeType = '${DRIVE_FOLDER_MIME_TYPE}'`)
  } else if (input.itemType === 'file') {
    predicates.push(`mimeType != '${DRIVE_FOLDER_MIME_TYPE}'`)
  }
  if (input.parentFolderIdOrUri !== undefined) {
    const parent = parseFolderReference(
      input.parentFolderIdOrUri,
      'searchDriveItems parentFolderIdOrUri'
    )
    predicates.push(`'${escapeDriveQueryValue(parent.id)}' in parents`)
  }
  const { pageSize, pageToken } = pageControls(input)
  const result = await searchDriveFiles({
    q: predicates.join(' and '),
    spaces: 'drive',
    orderBy: 'modifiedTime desc,name',
    pageSize,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: DRIVE_RESULT_FIELDS,
    ...(pageToken ? { pageToken } : {}),
  })
  return JSON.stringify(result)
}

/** Execute one bounded parent-scoped Drive listing page. */
export async function executeListDriveFolder(
  input: JsonRecord
): Promise<string> {
  const folder = parseFolderReference(input.folderIdOrUri, 'listDriveFolder')
  const { pageSize, pageToken } = pageControls(input)
  const result = await searchDriveFiles({
    q: `'${escapeDriveQueryValue(folder.id)}' in parents and trashed = false`,
    spaces: 'drive',
    orderBy: 'name',
    pageSize,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: DRIVE_RESULT_FIELDS,
    ...(pageToken ? { pageToken } : {}),
  })
  return JSON.stringify({ folderUri: folder.uri, ...result })
}

/** Return privacy-preserving Drive sharing facts for policy context. */
export async function executeInspectDriveItemAccess(
  input: JsonRecord
): Promise<string> {
  const item =
    typeof input.itemIdOrUri === 'string' ? input.itemIdOrUri.trim() : ''
  if (!item) {
    throw new Error('inspectDriveItemAccess requires a Drive item ID or URI')
  }
  if (
    input.itemType !== undefined &&
    input.itemType !== 'file' &&
    input.itemType !== 'folder'
  ) {
    throw new Error('inspectDriveItemAccess itemType must be file or folder')
  }
  return JSON.stringify(
    await inspectDriveItemAccess(
      item,
      input.itemType === 'file' ? 'file' : 'folder'
    )
  )
}

/** Execute the explicit, idempotent mount after a folder has been resolved. */
export async function executeMountDriveFolder(
  input: JsonRecord
): Promise<string> {
  const folder = parseFolderReference(input.folderIdOrUri, 'mountDriveFolder')
  return JSON.stringify(await mountDriveFolder(folder.uri))
}
