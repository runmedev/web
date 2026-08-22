import { getGoogleDriveBaseUrl } from '../../lib/googleDriveRuntime'

export const GOOGLE_DRIVE_FOLDER_MIME_TYPE =
  'application/vnd.google-apps.folder'
export const GOOGLE_DRIVE_SHORTCUT_MIME_TYPE =
  'application/vnd.google-apps.shortcut'

export type GoogleDriveLocation = {
  id: string
  name: string
  driveId?: string
}

export type GoogleDriveResource = GoogleDriveLocation & {
  mimeType: string
}

type DriveListResponse = {
  drives?: Array<Partial<GoogleDriveLocation>>
  nextPageToken?: string
}

type DriveApiResource = Partial<GoogleDriveResource> & {
  shortcutDetails?: {
    targetId?: string
    targetMimeType?: string
  }
}

type FileListResponse = {
  files?: DriveApiResource[]
  incompleteSearch?: boolean
  nextPageToken?: string
}

/**
 * Signals that Drive returned only a partial all-Drive result set. Callers
 * must not present collected matches as exhaustive and should ask the user to
 * narrow the query before retrying.
 */
export class IncompleteGoogleDriveSearchError extends Error {
  constructor() {
    super(
      'Google Drive could not search every accessible Drive. Narrow the search and retry.'
    )
    this.name = 'IncompleteGoogleDriveSearchError'
  }
}

/**
 * Converts one Drive API file into a navigable picker resource. Folder
 * shortcuts use their target id and MIME type; their source drive id is
 * intentionally discarded because a shortcut can target another Drive.
 */
function normalizeGoogleDriveResource(
  file: DriveApiResource,
  parentDriveId?: string
): GoogleDriveResource | null {
  if (
    typeof file.id !== 'string' ||
    typeof file.name !== 'string' ||
    typeof file.mimeType !== 'string'
  ) {
    return null
  }

  if (
    file.mimeType === GOOGLE_DRIVE_SHORTCUT_MIME_TYPE &&
    typeof file.shortcutDetails?.targetId === 'string' &&
    typeof file.shortcutDetails.targetMimeType === 'string'
  ) {
    return {
      id: file.shortcutDetails.targetId,
      name: file.name,
      mimeType: file.shortcutDetails.targetMimeType,
      driveId: undefined,
    }
  }

  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    driveId: file.driveId ?? parentDriveId,
  }
}

/**
 * Builds a Drive v3 URL against the configured runtime endpoint. The trailing
 * slash keeps relative API paths stable for production and test base URLs.
 */
function driveApiUrl(path: string): URL {
  const baseUrl = getGoogleDriveBaseUrl() || 'https://www.googleapis.com'
  return new URL(path, `${baseUrl}/`)
}

/** Escapes backslashes and quotes before text is embedded in a Drive query. */
function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * Performs one authenticated Drive request and returns its JSON body. Errors
 * expose only the operation and status code, never the bearer token or body.
 */
async function getJson<T>(
  url: URL,
  accessToken: string,
  operation: string,
  fetchImpl: typeof fetch
): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new Error(
      `Google Drive API could not ${operation} (HTTP ${response.status}).`
    )
  }
  return (await response.json()) as T
}

/**
 * Lists the roots the active Drive identity can browse. My Drive's `root`
 * alias is resolved to its immutable id before selection; Shared Drive ids are
 * already their top-level folder ids.
 */
export async function listGoogleDriveRoots(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<GoogleDriveLocation[]> {
  const myDriveUrl = driveApiUrl('drive/v3/files/root')
  myDriveUrl.searchParams.set('fields', 'id')
  const myDrive = await getJson<Partial<GoogleDriveLocation>>(
    myDriveUrl,
    accessToken,
    'resolve the My Drive root',
    fetchImpl
  )
  if (typeof myDrive.id !== 'string') {
    throw new Error('Google Drive API returned an invalid My Drive root.')
  }

  const roots: GoogleDriveLocation[] = [
    { id: myDrive.id, name: 'My Drive' },
  ]
  let pageToken: string | undefined

  do {
    const url = driveApiUrl('drive/v3/drives')
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('fields', 'nextPageToken,drives(id,name)')
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }
    const page = await getJson<DriveListResponse>(
      url,
      accessToken,
      'list Shared Drives',
      fetchImpl
    )
    for (const drive of page.drives ?? []) {
      if (typeof drive.id === 'string' && typeof drive.name === 'string') {
        roots.push({ id: drive.id, name: drive.name, driveId: drive.id })
      }
    }
    pageToken = page.nextPageToken
  } while (pageToken)

  return [
    roots[0],
    ...roots
      .slice(1)
      .sort((left, right) => left.name.localeCompare(right.name)),
  ]
}

/**
 * Lists one folder's children with the same credential used by the picker.
 * Shared Drive navigation keeps the drive corpus explicit on every page.
 */
export async function listGoogleDriveChildren(
  accessToken: string,
  parent: GoogleDriveLocation,
  fetchImpl: typeof fetch = fetch
): Promise<GoogleDriveResource[]> {
  const resources: GoogleDriveResource[] = []
  let pageToken: string | undefined

  do {
    const url = driveApiUrl('drive/v3/files')
    url.searchParams.set('pageSize', '100')
    url.searchParams.set(
      'fields',
      'nextPageToken,files(id,name,mimeType,driveId,shortcutDetails(targetId,targetMimeType))'
    )
    url.searchParams.set(
      'q',
      `'${escapeDriveQueryLiteral(parent.id)}' in parents and trashed = false`
    )
    url.searchParams.set('spaces', 'drive')
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('includeItemsFromAllDrives', 'true')
    url.searchParams.set('orderBy', 'folder,name_natural')
    if (parent.driveId) {
      url.searchParams.set('corpora', 'drive')
      url.searchParams.set('driveId', parent.driveId)
    }
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }

    const page = await getJson<FileListResponse>(
      url,
      accessToken,
      `list items in ${parent.name}`,
      fetchImpl
    )
    for (const file of page.files ?? []) {
      const resource = normalizeGoogleDriveResource(file, parent.driveId)
      if (resource) {
        resources.push(resource)
      }
    }
    pageToken = page.nextPageToken
  } while (pageToken)

  return resources
}

/**
 * Searches every Drive corpus visible to the active identity. Folder mode
 * narrows the query server-side; file mode includes folders for navigation.
 */
export async function searchGoogleDriveResources(
  accessToken: string,
  query: string,
  mode: 'file' | 'folder',
  fetchImpl: typeof fetch = fetch
): Promise<GoogleDriveResource[]> {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) {
    return []
  }

  const resources: GoogleDriveResource[] = []
  let incompleteSearch = false
  let pageToken: string | undefined
  do {
    const url = driveApiUrl('drive/v3/files')
    const clauses = [
      `name contains '${escapeDriveQueryLiteral(normalizedQuery)}'`,
      'trashed = false',
    ]
    if (mode === 'folder') {
      clauses.push(
        `(mimeType = '${GOOGLE_DRIVE_FOLDER_MIME_TYPE}' or mimeType = '${GOOGLE_DRIVE_SHORTCUT_MIME_TYPE}')`
      )
    }
    url.searchParams.set('q', clauses.join(' and '))
    url.searchParams.set('pageSize', '100')
    url.searchParams.set(
      'fields',
      'nextPageToken,incompleteSearch,files(id,name,mimeType,driveId,shortcutDetails(targetId,targetMimeType))'
    )
    url.searchParams.set('spaces', 'drive')
    url.searchParams.set('corpora', 'allDrives')
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('includeItemsFromAllDrives', 'true')
    url.searchParams.set('orderBy', 'folder,name_natural')
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }

    const page = await getJson<FileListResponse>(
      url,
      accessToken,
      `search Drive for ${normalizedQuery}`,
      fetchImpl
    )
    for (const file of page.files ?? []) {
      const resource = normalizeGoogleDriveResource(file)
      if (resource) {
        resources.push(resource)
      }
    }
    incompleteSearch ||= page.incompleteSearch === true
    pageToken = page.nextPageToken
  } while (pageToken)

  if (incompleteSearch) {
    throw new IncompleteGoogleDriveSearchError()
  }

  return mode === 'folder'
    ? resources.filter(
        (resource) => resource.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE
      )
    : resources
}
