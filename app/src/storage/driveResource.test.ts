// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DRIVE_RESUMABLE_CHUNK_BYTES, DriveNotebookStore } from './drive'

const fileUri = 'https://drive.google.com/file/d/file-123/view'
const folderUri = 'https://drive.google.com/drive/folders/folder-123'

describe('DriveNotebookStore linked resources', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads authoritative metadata with non-interactive authorization', async () => {
    const ensureAccessToken = vi.fn().mockResolvedValue('access-token')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'file-123',
          name: 'demo.webm',
          mimeType: 'video/webm',
          size: '42',
          modifiedTime: '2026-08-18T00:00:00Z',
          md5Checksum: 'checksum',
          capabilities: { canDownload: true },
          parents: ['folder-123'],
        }),
        { status: 200 }
      )
    )
    const store = new DriveNotebookStore(ensureAccessToken)

    await expect(store.getResourceMetadata(fileUri)).resolves.toMatchObject({
      uri: fileUri,
      name: 'demo.webm',
      mimeType: 'video/webm',
      sizeBytes: 42,
      canDownload: true,
      parents: ['folder-123'],
    })
    expect(ensureAccessToken).toHaveBeenCalledWith({
      interactive: false,
      forceRefresh: false,
    })
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/drive/v3/files/file-123'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer access-token' },
      })
    )
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).not.toContain(
      'access-token'
    )
  })

  it('maps Drive authorization failures to stable resource errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('forbidden', { status: 403 })
    )
    const store = new DriveNotebookStore(async () => 'access-token')

    await expect(store.getResourceMetadata(fileUri)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    })
  })

  it('returns an authenticated streaming media response', async () => {
    const response = new Response('video-bytes', { status: 200 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    const store = new DriveNotebookStore(async () => 'access-token')

    await expect(store.fetch(fileUri)).resolves.toBe(response)
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('alt=media'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer access-token' },
      })
    )
  })

  it('retries one 401 with a forced non-interactive refresh', async () => {
    const ensureAccessToken = vi
      .fn()
      .mockResolvedValueOnce('expired-token')
      .mockResolvedValueOnce('refreshed-token')
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('video', { status: 200 }))
    const store = new DriveNotebookStore(ensureAccessToken)

    await expect(store.fetch(fileUri)).resolves.toBeInstanceOf(Response)
    expect(ensureAccessToken).toHaveBeenNthCalledWith(2, {
      interactive: false,
      forceRefresh: true,
    })
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer refreshed-token',
        }),
      })
    )
  })

  it('uses the opaque Drive permission ID as the principal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user: { permissionId: 'permission-123' } }))
    )
    const store = new DriveNotebookStore(async () => 'access-token')

    await expect(store.getPrincipal()).resolves.toEqual({
      permissionId: 'permission-123',
    })
  })

  it('uploads binary bodies in aligned resumable chunks', async () => {
    const store = new DriveNotebookStore(async () => 'access-token')
    vi.spyOn(store, 'search').mockResolvedValue({ files: [] })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { Location: 'https://www.googleapis.com/upload/session' },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 308 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'file-123',
            name: 'demo.webm',
            mimeType: 'video/webm',
            size: String(DRIVE_RESUMABLE_CHUNK_BYTES + 1),
            capabilities: { canDownload: true },
          }),
          { status: 200 }
        )
      )
    const progress = vi.fn()
    const body = new Uint8Array(DRIVE_RESUMABLE_CHUNK_BYTES + 1)

    await expect(
      store.uploadResource(folderUri, 'demo.webm', body, {
        mimeType: 'video/webm',
        operationId: 'operation-123',
        onProgress: progress,
      })
    ).resolves.toMatchObject({ uri: fileUri, sizeBytes: body.byteLength })

    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          'content-range': `bytes 0-${DRIVE_RESUMABLE_CHUNK_BYTES - 1}/${body.byteLength}`,
        }),
      })
    )
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          'content-range': `bytes ${DRIVE_RESUMABLE_CHUNK_BYTES}-${DRIVE_RESUMABLE_CHUNK_BYTES}/${body.byteLength}`,
        }),
      })
    )
    expect(progress).toHaveBeenLastCalledWith(body.byteLength, body.byteLength)
  })

  it('reuses an upload created with the same operation ID', async () => {
    const store = new DriveNotebookStore(async () => 'access-token')
    vi.spyOn(store, 'search').mockResolvedValue({
      files: [
        {
          id: 'file-123',
          name: 'demo.webm',
          mimeType: 'video/webm',
          size: '4',
          capabilities: { canDownload: true },
        },
      ],
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await expect(
      store.uploadResource(folderUri, 'demo.webm', new Uint8Array(4), {
        mimeType: 'video/webm',
        operationId: 'same-operation',
      })
    ).resolves.toMatchObject({ uri: fileUri })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never sends a bearer token to an unexpected upload origin', async () => {
    const store = new DriveNotebookStore(async () => 'access-token')
    vi.spyOn(store, 'search').mockResolvedValue({ files: [] })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { Location: 'https://attacker.example/upload/session' },
      })
    )

    await expect(
      store.uploadResource(folderUri, 'demo.webm', new Uint8Array([1]), {
        mimeType: 'video/webm',
        operationId: 'origin-check',
      })
    ).rejects.toMatchObject({ code: 'UPLOAD_INTERRUPTED' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reuses the stable asset folder associated with the notebook ID', async () => {
    const store = new DriveNotebookStore(async () => 'access-token')
    vi.spyOn(store, 'getResourceMetadata').mockResolvedValue({
      uri: fileUri,
      name: 'notebook.json',
      mimeType: 'application/json',
      canDownload: true,
      parents: ['parent-123'],
    })
    const search = vi.spyOn(store, 'search').mockResolvedValue({
      files: [
        {
          id: 'assets-123',
          name: 'notebook.json.assets',
          mimeType: 'application/vnd.google-apps.folder',
        },
      ],
    })

    await expect(
      store.resolveAssetFolder(fileUri, 'notebook.json')
    ).resolves.toBe('https://drive.google.com/drive/folders/assets-123')
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringContaining('runmeNotebookFileId'),
      })
    )
  })
})
