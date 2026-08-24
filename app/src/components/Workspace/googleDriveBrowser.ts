import { getGoogleDriveBaseUrl } from '../../lib/googleDriveRuntime'

export const GOOGLE_DRIVE_FOLDER_MIME_TYPE =
  'application/vnd.google-apps.folder'
export const GOOGLE_DRIVE_SHORTCUT_MIME_TYPE =
  'application/vnd.google-apps.shortcut'

export type GoogleDriveLocation = {
  id: string
  name: string
  driveId?: string
  resourceKey?: string
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
    targetResourceKey?: string
  }
}

type FileListResponse = {
  files?: DriveApiResource[]
  incompleteSearch?: boolean
  nextPageToken?: string
}

const FUZZY_SEARCH_MAX_PAGES = 3
const FUZZY_SEARCH_MIN_QUERY_LENGTH = 6

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
      ...(file.shortcutDetails.targetResourceKey
        ? { resourceKey: file.shortcutDetails.targetResourceKey }
        : {}),
    }
  }

  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    driveId: file.driveId ?? parentDriveId,
    ...(file.resourceKey ? { resourceKey: file.resourceKey } : {}),
  }
}

/** Builds Drive's resource-key header for a protected item when available. */
function driveResourceKeyHeader(
  location: Pick<GoogleDriveLocation, 'id' | 'resourceKey'>
): Record<string, string> {
  if (!location.resourceKey) {
    return {}
  }
  return {
    'X-Goog-Drive-Resource-Keys': `${location.id}/${location.resourceKey}`,
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

/** Normalizes names before local relevance and edit-distance comparisons. */
function normalizeSearchName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase()
}

/**
 * Returns a narrow Drive-supported prefix for collecting fuzzy candidates.
 * Drive only supports prefix matching for `name contains`, so Runme asks for
 * a stable leading token (or half of a single token) and ranks that bounded
 * candidate set locally.
 */
function fuzzyCandidatePrefix(query: string): string | null {
  if (query.length < FUZZY_SEARCH_MIN_QUERY_LENGTH) {
    return null
  }

  const separator = query.search(/[\s._-]/)
  const prefixLength =
    separator >= 3 ? separator : Math.max(3, Math.floor(query.length / 2))
  if (prefixLength >= query.length) {
    return null
  }
  return query.slice(0, prefixLength)
}

/** Calculates Levenshtein edit distance with O(min(a, b)) memory. */
function editDistance(left: string, right: string): number {
  if (left === right) {
    return 0
  }
  if (left.length > right.length) {
    return editDistance(right, left)
  }

  let previous = Array.from({ length: left.length + 1 }, (_, index) => index)
  for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
    const current = [rightIndex]
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      current[leftIndex] = Math.min(
        (current[leftIndex - 1] ?? 0) + 1,
        (previous[leftIndex] ?? 0) + 1,
        (previous[leftIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[left.length] ?? right.length
}

function fuzzySearchDistanceLimit(queryLength: number): number {
  if (queryLength < FUZZY_SEARCH_MIN_QUERY_LENGTH) {
    return 0
  }
  if (queryLength < 10) {
    return 1
  }
  return Math.min(3, Math.ceil(queryLength * 0.12))
}

/**
 * Performs one authenticated Drive request and returns its JSON body. Errors
 * expose only the operation and status code, never the bearer token or body.
 */
async function getJson<T>(
  url: URL,
  accessToken: string,
  operation: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string> = {}
): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}`, ...headers },
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

  const roots: GoogleDriveLocation[] = [{ id: myDrive.id, name: 'My Drive' }]
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
  mode: 'file' | 'folder',
  fetchImpl: typeof fetch = fetch
): Promise<GoogleDriveResource[]> {
  const resources: GoogleDriveResource[] = []
  let pageToken: string | undefined

  do {
    const url = driveApiUrl('drive/v3/files')
    url.searchParams.set('pageSize', '100')
    url.searchParams.set(
      'fields',
      'nextPageToken,files(id,name,mimeType,driveId,resourceKey,shortcutDetails(targetId,targetMimeType,targetResourceKey))'
    )
    const queryClauses = [
      `'${escapeDriveQueryLiteral(parent.id)}' in parents`,
      'trashed = false',
    ]
    if (mode === 'folder') {
      queryClauses.push(
        `(mimeType = '${GOOGLE_DRIVE_FOLDER_MIME_TYPE}' or mimeType = '${GOOGLE_DRIVE_SHORTCUT_MIME_TYPE}')`
      )
    }
    url.searchParams.set('q', queryClauses.join(' and '))
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
      fetchImpl,
      driveResourceKeyHeader(parent)
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

  const searchPrefix = async (
    prefix: string,
    maxPages = Number.POSITIVE_INFINITY
  ): Promise<GoogleDriveResource[]> => {
    const matches: GoogleDriveResource[] = []
    let pageCount = 0
    let pageToken: string | undefined
    do {
      const url = driveApiUrl('drive/v3/files')
      const clauses = [
        `name contains '${escapeDriveQueryLiteral(prefix)}'`,
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
        'nextPageToken,incompleteSearch,files(id,name,mimeType,driveId,resourceKey,shortcutDetails(targetId,targetMimeType,targetResourceKey))'
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
      if (page.incompleteSearch === true) {
        throw new IncompleteGoogleDriveSearchError()
      }
      for (const file of page.files ?? []) {
        const resource = normalizeGoogleDriveResource(file)
        if (resource) {
          matches.push(resource)
        }
      }
      pageToken = page.nextPageToken
      pageCount += 1
    } while (pageToken && pageCount < maxPages)

    return mode === 'folder'
      ? matches.filter(
          (resource) => resource.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE
        )
      : matches
  }

  const resources = await searchPrefix(normalizedQuery)
  const comparableQuery = normalizeSearchName(normalizedQuery)
  const distanceLimit = fuzzySearchDistanceLimit(comparableQuery.length)
  if (
    resources.some(
      (resource) =>
        editDistance(comparableQuery, normalizeSearchName(resource.name)) <=
        distanceLimit
    )
  ) {
    return resources
  }

  const candidatePrefix = fuzzyCandidatePrefix(normalizedQuery)
  if (!candidatePrefix) {
    return resources
  }

  const fuzzyMatches = (
    await searchPrefix(candidatePrefix, FUZZY_SEARCH_MAX_PAGES)
  ).filter(
    (resource) =>
      editDistance(comparableQuery, normalizeSearchName(resource.name)) <=
      distanceLimit
  )
  const combined = new Map(
    [...resources, ...fuzzyMatches].map((resource) => [resource.id, resource])
  )

  return [...combined.values()].sort((left, right) => {
    const leftDistance = editDistance(
      comparableQuery,
      normalizeSearchName(left.name)
    )
    const rightDistance = editDistance(
      comparableQuery,
      normalizeSearchName(right.name)
    )
    return leftDistance - rightDistance || left.name.localeCompare(right.name)
  })
}
