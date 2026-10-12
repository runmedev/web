/// <reference types="vitest" />
import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearGoogleDriveRuntime } from '../lib/googleDriveRuntime'
import { DriveNotebookStore } from './drive'

afterEach(() => {
  clearGoogleDriveRuntime()
  vi.restoreAllMocks()
})

/** Installs an authenticated mock Default Drive REST client for one browser test. */

describe('GAPI Drive client', () => {
  it('sends rename metadata through the REST request path', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input))
        expect(url.pathname).toBe('/drive/v3/files/file123')
        expect(url.searchParams.get('supportsAllDrives')).toBe('true')
        expect(init?.method).toBe('PATCH')
        expect(JSON.parse(String(init?.body))).toEqual({
          name: 'renamed.json',
        })
        return new Response(
          JSON.stringify({
            id: 'file123',
            name: 'renamed.json',
            mimeType: 'application/json',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      })

    const store = new DriveNotebookStore(async () => 'access-token')
    await expect(
      store.rename(
        'https://drive.google.com/file/d/file123/view',
        'renamed.json'
      )
    ).resolves.toMatchObject({
      uri: 'https://drive.google.com/file/d/file123/view',
      name: 'renamed.json',
      remoteUri: 'https://drive.google.com/file/d/file123/view',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a rename response that kept the old name', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'file123',
          name: 'original.json',
          mimeType: 'application/json',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )

    const store = new DriveNotebookStore(async () => 'access-token')
    await expect(
      store.rename(
        'https://drive.google.com/file/d/file123/view',
        'renamed.json'
      )
    ).rejects.toThrow(
      'Google Drive returned success without applying the requested rename to "renamed.json".'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('decodes UTF-8 file and revision content without emoji mojibake', async () => {
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

it('uses current tokens on the default production endpoint without loading any SDK', async () => {
  const scriptCount = document.scripts.length
  let token = 'first'
  const tokens: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(new URL(String(input)).origin).toBe('https://www.googleapis.com')
    tokens.push(new Headers(init?.headers).get('Authorization')!)
    return new Response('hello', { headers: { 'Content-Type': 'text/plain' } })
  })
  const store = new DriveNotebookStore(async () => token)
  await store.loadContent('https://drive.google.com/file/d/file123/view')
  token = 'renewed'
  await store.loadContent('https://drive.google.com/file/d/file123/view')
  expect(tokens).toEqual(['Bearer first', 'Bearer renewed'])
  expect(document.scripts.length).toBe(scriptCount)
})
