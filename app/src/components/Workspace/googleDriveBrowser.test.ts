import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearGoogleDriveRuntime,
  setGoogleDriveBaseUrl,
} from '../../lib/googleDriveRuntime'
import {
  listGoogleDriveChildren,
  listGoogleDriveRoots,
  searchGoogleDriveResources,
} from './googleDriveBrowser'

describe('googleDriveBrowser', () => {
  afterEach(() => clearGoogleDriveRuntime())

  it('lists My Drive and paginated Shared Drive roots', async () => {
    setGoogleDriveBaseUrl('https://drive.example.test')
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            drives: [{ id: 'z-drive', name: 'Zeta' }],
            nextPageToken: 'page-2',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ drives: [{ id: 'a-drive', name: 'Alpha' }] }),
          { status: 200 }
        )
      )

    await expect(
      listGoogleDriveRoots('secret-token', fetchImpl)
    ).resolves.toEqual([
      { id: 'root', name: 'My Drive' },
      { id: 'a-drive', name: 'Alpha', driveId: 'a-drive' },
      { id: 'z-drive', name: 'Zeta', driveId: 'z-drive' },
    ])

    const firstUrl = new URL(fetchImpl.mock.calls[0]?.[0] as string)
    const secondUrl = new URL(fetchImpl.mock.calls[1]?.[0] as string)
    expect(firstUrl.origin).toBe('https://drive.example.test')
    expect(secondUrl.searchParams.get('pageToken')).toBe('page-2')
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual({
      headers: { Authorization: 'Bearer secret-token' },
    })
  })

  it('lists Shared Drive children with the drive corpus', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          files: [
            {
              id: 'folder-1',
              name: 'Designs',
              mimeType: 'application/vnd.google-apps.folder',
            },
          ],
        }),
        { status: 200 }
      )
    )

    await expect(
      listGoogleDriveChildren(
        'token',
        { id: 'drive-1', name: 'notebooks', driveId: 'drive-1' },
        fetchImpl
      )
    ).resolves.toEqual([
      {
        id: 'folder-1',
        name: 'Designs',
        mimeType: 'application/vnd.google-apps.folder',
        driveId: 'drive-1',
      },
    ])

    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string)
    expect(url.searchParams.get('corpora')).toBe('drive')
    expect(url.searchParams.get('driveId')).toBe('drive-1')
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true')
    expect(url.searchParams.get('q')).toBe(
      "'drive-1' in parents and trashed = false"
    )
  })

  it('does not leak the token in Drive API errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('disabled', { status: 403 }))

    const error = await listGoogleDriveRoots(
      'very-secret-token',
      fetchImpl
    ).catch((caught) => caught)
    expect(String(error)).toContain('HTTP 403')
    expect(String(error)).not.toContain('very-secret-token')
  })

  it('searches all visible Drives and filters folder mode server-side', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          files: [
            {
              id: 'folder-1',
              name: "Bob's Plans",
              mimeType: 'application/vnd.google-apps.folder',
              driveId: 'drive-1',
            },
          ],
        }),
        { status: 200 }
      )
    )

    await expect(
      searchGoogleDriveResources(
        'token',
        " Bob's \\ Plans ",
        'folder',
        fetchImpl
      )
    ).resolves.toEqual([
      {
        id: 'folder-1',
        name: "Bob's Plans",
        mimeType: 'application/vnd.google-apps.folder',
        driveId: 'drive-1',
      },
    ])

    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string)
    expect(url.searchParams.get('corpora')).toBe('allDrives')
    expect(url.searchParams.get('q')).toBe(
      "name contains 'Bob\\'s \\\\ Plans' and trashed = false and mimeType = 'application/vnd.google-apps.folder'"
    )
  })
})
