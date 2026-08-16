/// <reference types="vitest" />
import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearGoogleDriveRuntime } from '../lib/googleDriveRuntime'
import { DriveNotebookStore } from './drive'

const originalGapi = window.gapi

afterEach(() => {
  clearGoogleDriveRuntime()
  vi.restoreAllMocks()
  window.gapi = originalGapi
})

describe('GAPI Drive media downloads', () => {
  it('decodes UTF-8 file and revision content without emoji mojibake', async () => {
    const mojibake = '{"text":"ðð½"}'
    const filesGet = vi.fn().mockResolvedValue({ body: mojibake })
    const revisionsGet = vi.fn().mockResolvedValue({ body: mojibake })

    window.gapi = {
      load: (_name, options) => options.callback(),
      client: {
        load: vi.fn().mockResolvedValue(undefined),
        setToken: vi.fn(),
        getToken: () => ({ access_token: 'access-token' }),
        drive: {
          files: {
            create: vi.fn(),
            update: vi.fn(),
            get: filesGet,
            list: vi.fn(),
          },
          drives: { get: vi.fn() },
          revisions: { get: revisionsGet, list: vi.fn() },
        },
        request: vi.fn(),
      },
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('{"text":"👍🏽"}', {
          status: 200,
          headers: { 'Content-Type': 'application/x-ipynb+json' },
        })
    )

    const store = new DriveNotebookStore(async () => 'access-token')

    await expect(
      store.loadContent('https://drive.google.com/file/d/file123/view')
    ).resolves.toBe('{"text":"👍🏽"}')
    await expect(
      store.loadRevisionContent(
        'https://drive.google.com/file/d/file123/view',
        'revision456'
      )
    ).resolves.toBe('{"text":"👍🏽"}')
    expect(filesGet).not.toHaveBeenCalled()
    expect(revisionsGet).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/file123?supportsAllDrives=true&alt=media',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
        }),
      })
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/file123/revisions/revision456?supportsAllDrives=true&alt=media',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
        }),
      })
    )
  })
})
