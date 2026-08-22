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
        'https://drive.google.com/file/d/file123/view?resourcekey=file-key',
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
          'X-Goog-Drive-Resource-Keys': 'file123/file-key',
        }),
      })
    )
  })

  it('authorizes protected parents for create and move requests', async () => {
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
            get: vi.fn(),
            list: vi.fn(),
          },
          drives: { get: vi.fn() },
          revisions: { get: vi.fn(), list: vi.fn() },
        },
        request: vi.fn(),
      },
    }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input))
        const headers = new Headers(init?.headers)
        expect(headers.get('Authorization')).toBe('Bearer access-token')

        if (init?.method === 'POST') {
          expect(url.pathname).toBe('/drive/v3/files')
          expect(headers.get('X-Goog-Drive-Resource-Keys')).toBe(
            'parent123/parent-key'
          )
          return new Response(
            JSON.stringify({
              id: 'folder123',
              name: 'Reports',
              mimeType: 'application/vnd.google-apps.folder',
              parents: ['parent123'],
            })
          )
        }

        expect(init?.method).toBe('PATCH')
        expect(url.pathname).toBe('/drive/v3/files/file123')
        expect(headers.get('X-Goog-Drive-Resource-Keys')).toBe(
          'source123/source-key,destination123/destination-key'
        )
        expect(url.searchParams.get('resourceKey')).toBe('file-key')
        return new Response(
          JSON.stringify({
            id: 'file123',
            name: 'notebook.json',
            mimeType: 'application/json',
            parents: ['destination123'],
          })
        )
      })

    const store = new DriveNotebookStore(async () => 'access-token')
    await store.createFolder(
      'https://drive.google.com/drive/folders/parent123?resourcekey=parent-key',
      'Reports'
    )
    await store.move(
      'https://drive.google.com/file/d/file123/view?resourcekey=file-key',
      'https://drive.google.com/drive/folders/source123?resourcekey=source-key',
      'https://drive.google.com/drive/folders/destination123?resourcekey=destination-key'
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
