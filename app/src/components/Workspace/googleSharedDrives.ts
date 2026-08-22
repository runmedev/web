import { getGoogleDriveBaseUrl } from '../../lib/googleDriveRuntime'

export type GoogleSharedDrive = {
  id: string
  name: string
}

type SharedDriveListResponse = {
  drives?: Array<Partial<GoogleSharedDrive>>
  nextPageToken?: string
}

function sharedDrivesUrl(pageToken?: string): string {
  const baseUrl = getGoogleDriveBaseUrl() || 'https://www.googleapis.com'
  const url = new URL('drive/v3/drives', `${baseUrl}/`)
  url.searchParams.set('pageSize', '100')
  url.searchParams.set('fields', 'nextPageToken,drives(id,name)')
  if (pageToken) {
    url.searchParams.set('pageToken', pageToken)
  }
  return url.toString()
}

/**
 * Lists Shared Drives accessible to the active credential. Google Picker can
 * browse these drives, but it does not allow selecting a Shared Drive root.
 */
export async function listGoogleSharedDrives(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<GoogleSharedDrive[]> {
  const drives: GoogleSharedDrive[] = []
  let pageToken: string | undefined

  do {
    const response = await fetchImpl(sharedDrivesUrl(pageToken), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
    if (!response.ok) {
      throw new Error(
        `Google Drive API could not list Shared Drives (HTTP ${response.status}).`
      )
    }

    const page = (await response.json()) as SharedDriveListResponse
    for (const drive of page.drives ?? []) {
      if (typeof drive.id === 'string' && typeof drive.name === 'string') {
        drives.push({ id: drive.id, name: drive.name })
      }
    }
    pageToken = page.nextPageToken
  } while (pageToken)

  return drives.sort((left, right) => left.name.localeCompare(right.name))
}
