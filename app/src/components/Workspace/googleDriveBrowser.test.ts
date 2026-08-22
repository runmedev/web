import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearGoogleDriveRuntime,
  setGoogleDriveBaseUrl,
} from '../../lib/googleDriveRuntime'
import {
  IncompleteGoogleDriveSearchError,
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
        new Response(JSON.stringify({ id: 'my-drive-root-id' }), {
          status: 200,
        })
      )
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
      { id: 'my-drive-root-id', name: 'My Drive' },
      { id: 'a-drive', name: 'Alpha', driveId: 'a-drive' },
      { id: 'z-drive', name: 'Zeta', driveId: 'z-drive' },
    ])

    const rootUrl = new URL(fetchImpl.mock.calls[0]?.[0] as string)
    const firstDrivesUrl = new URL(fetchImpl.mock.calls[1]?.[0] as string)
    const secondDrivesUrl = new URL(fetchImpl.mock.calls[2]?.[0] as string)
    expect(rootUrl.origin).toBe('https://drive.example.test')
    expect(rootUrl.pathname).toBe('/drive/v3/files/root')
    expect(firstDrivesUrl.pathname).toBe('/drive/v3/drives')
    expect(secondDrivesUrl.searchParams.get('pageToken')).toBe('page-2')
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual({
      headers: { Authorization: 'Bearer secret-token' },
    })
  })

  it('rejects an invalid My Drive root before listing selectable locations', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ name: 'missing id' }), { status: 200 })
      )

    await expect(listGoogleDriveRoots('token', fetchImpl)).rejects.toThrow(
      'invalid My Drive root'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
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
        'file',
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

  it('resolves folder shortcuts into navigable target resources', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          files: [
            {
              id: 'shortcut-1',
              name: 'Designs shortcut',
              mimeType: 'application/vnd.google-apps.shortcut',
              driveId: 'source-drive',
              shortcutDetails: {
                targetId: 'folder-target',
                targetMimeType: 'application/vnd.google-apps.folder',
                targetResourceKey: 'target-key',
              },
            },
          ],
        }),
        { status: 200 }
      )
    )

    await expect(
      listGoogleDriveChildren(
        'token',
        {
          id: 'drive-1',
          name: 'notebooks',
          driveId: 'drive-1',
          resourceKey: 'parent-key',
        },
        'folder',
        fetchImpl
      )
    ).resolves.toEqual([
      {
        id: 'folder-target',
        name: 'Designs shortcut',
        mimeType: 'application/vnd.google-apps.folder',
        driveId: undefined,
        resourceKey: 'target-key',
      },
    ])

    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string)
    expect(url.searchParams.get('fields')).toContain(
      'shortcutDetails(targetId,targetMimeType,targetResourceKey)'
    )
    expect(url.searchParams.get('q')).toBe(
      "'drive-1' in parents and trashed = false and " +
        "(mimeType = 'application/vnd.google-apps.folder' or " +
        "mimeType = 'application/vnd.google-apps.shortcut')"
    )
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual({
      headers: {
        Authorization: 'Bearer token',
        'X-Goog-Drive-Resource-Keys': 'drive-1/parent-key',
      },
    })
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
      "name contains 'Bob\\'s \\\\ Plans' and trashed = false and " +
        "(mimeType = 'application/vnd.google-apps.folder' or " +
        "mimeType = 'application/vnd.google-apps.shortcut')"
    )
  })

  it('keeps folder shortcuts in folder search results while filtering file targets', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          files: [
            {
              id: 'folder-shortcut',
              name: 'Designs',
              mimeType: 'application/vnd.google-apps.shortcut',
              shortcutDetails: {
                targetId: 'folder-target',
                targetMimeType: 'application/vnd.google-apps.folder',
              },
            },
            {
              id: 'file-shortcut',
              name: 'Design notes',
              mimeType: 'application/vnd.google-apps.shortcut',
              shortcutDetails: {
                targetId: 'file-target',
                targetMimeType: 'text/plain',
              },
            },
          ],
        }),
        { status: 200 }
      )
    )

    await expect(
      searchGoogleDriveResources('token', 'design', 'folder', fetchImpl)
    ).resolves.toEqual([
      {
        id: 'folder-target',
        name: 'Designs',
        mimeType: 'application/vnd.google-apps.folder',
        driveId: undefined,
      },
    ])

    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string)
    expect(url.searchParams.get('q')).toContain(
      "mimeType = 'application/vnd.google-apps.shortcut'"
    )
  })

  it('rejects incomplete all-Drive search results instead of presenting them as exhaustive', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          incompleteSearch: true,
          files: [
            {
              id: 'partial-result',
              name: 'Partial result',
              mimeType: 'application/vnd.google-apps.folder',
            },
          ],
        }),
        { status: 200 }
      )
    )

    await expect(
      searchGoogleDriveResources('token', 'design', 'folder', fetchImpl)
    ).rejects.toBeInstanceOf(IncompleteGoogleDriveSearchError)
  })
})
