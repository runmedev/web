// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setGoogleDriveBaseUrl } from '../../lib/googleDriveRuntime'
import { listGoogleSharedDrives } from './googleSharedDrives'

describe('listGoogleSharedDrives', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setGoogleDriveBaseUrl('https://drive.test')
  })

  it('paginates, authenticates, validates, and sorts Shared Drives', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            drives: [{ id: 'z-drive', name: 'Zulu' }, { id: 'invalid' }],
            nextPageToken: 'next-token',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            drives: [{ id: 'a-drive', name: 'Alpha' }],
          }),
          { status: 200 }
        )
      ) as unknown as typeof fetch

    await expect(
      listGoogleSharedDrives('impersonated-token', fetchImpl)
    ).resolves.toEqual([
      { id: 'a-drive', name: 'Alpha' },
      { id: 'z-drive', name: 'Zulu' },
    ])

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [firstUrl, firstOptions] = vi.mocked(fetchImpl).mock.calls[0] ?? []
    expect(String(firstUrl)).toContain('https://drive.test/drive/v3/drives?')
    expect(String(firstUrl)).toContain('pageSize=100')
    expect(firstOptions).toEqual({
      headers: { Authorization: 'Bearer impersonated-token' },
    })
    const [secondUrl] = vi.mocked(fetchImpl).mock.calls[1] ?? []
    expect(String(secondUrl)).toContain('pageToken=next-token')
  })

  it('returns an actionable status without exposing the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('Drive API disabled', {
        status: 403,
        statusText: 'Forbidden',
      })
    ) as unknown as typeof fetch

    await expect(
      listGoogleSharedDrives('secret-token', fetchImpl)
    ).rejects.toThrow(
      'Google Drive API could not list Shared Drives (HTTP 403)'
    )
    await expect(
      listGoogleSharedDrives('secret-token', fetchImpl)
    ).rejects.not.toThrow('secret-token')
  })
})
