import md5 from 'md5'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearGoogleDriveRuntime } from '../lib/googleDriveRuntime'
import { IPYNB_MIME_TYPE } from '../lib/ipynb'
import { DriveNotebookStore, driveFileUrl, driveFolderUrl } from './drive'
import { NotebookStoreItemType } from './notebook'

const source = driveFileUrl('source')
const copy = driveFileUrl('copy')
const legacyOperation = `runme-ipynb-${md5(source)}`
const target = {
  uri: copy,
  name: 'report.ipynb',
  type: NotebookStoreItemType.File,
  parents: [driveFolderUrl('parent')],
  children: [],
}

/** Legacy exports carry the same source reference regardless of the reader's app. */
function legacyContent(uri = source) {
  return JSON.stringify({
    nbformat: 4,
    cells: [],
    metadata: {
      runme: {
        derivedFrom: {
          version: 1,
          uri,
          notebookId: 'notebook',
          generatedAt: '2026-10-27T00:00:00Z',
        },
      },
    },
  })
}

/** Mock only network responses; exercise the actual Drive store across two tokens. */
function driveResponses(
  properties: Record<string, string> = {},
  content = legacyContent()
) {
  let metadata = {
    id: 'copy',
    name: 'report.ipynb',
    mimeType: IPYNB_MIME_TYPE,
    parents: ['parent'],
    properties,
  }
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.searchParams.get('alt') === 'media') return new Response(content)
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        expect(new Headers(init.headers).get('Authorization')).toBe(
          'Bearer workload'
        )
        expect(body.appProperties).toBeUndefined()
        metadata = { ...metadata, ...body }
        return Response.json(metadata)
      }
      if (init?.method === 'PATCH' && !url.pathname.startsWith('/upload/')) {
        const body = JSON.parse(String(init.body))
        metadata.properties = { ...metadata.properties, ...body.properties }
      }
      return Response.json(metadata)
    })
  return { fetch, metadata: () => metadata }
}

afterEach(() => {
  vi.restoreAllMocks()
  clearGoogleDriveRuntime()
})

describe('Colab source ownership across authentication clients', () => {
  it('creates with workload identity and verifies and saves with an end-user token', async () => {
    const remote = driveResponses()
    const workload = new DriveNotebookStore(async () => 'workload')
    const user = new DriveNotebookStore(async () => 'end-user')
    const created = await workload.createContent(
      driveFolderUrl('parent'),
      'report.ipynb',
      legacyContent(),
      IPYNB_MIME_TYPE,
      { derivedFromSourceId: 'source' }
    )
    expect(created.uri).toBe(copy)
    expect(remote.metadata().properties).toEqual({ runmeDerivedFrom: 'source' })
    expect(await user.getDerivedCopyTarget(copy, source)).toMatchObject({
      uri: copy,
    })
    await user.saveContent(copy, 'updated report', IPYNB_MIME_TYPE)
    expect(
      remote.fetch.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/upload/') &&
          init?.body === 'updated report' &&
          new Headers(init.headers).get('Authorization') === 'Bearer end-user'
      )
    ).toBe(true)
  })

  it('migrates an existing export when private appProperties are invisible', async () => {
    const remote = driveResponses({ unrelated: 'preserved' })
    const user = new DriveNotebookStore(async () => 'end-user')
    await expect(
      user.getDerivedCopyTarget(copy, source)
    ).resolves.toMatchObject({ uri: copy })
    expect(remote.metadata().properties).toEqual({
      unrelated: 'preserved',
      runmeDerivedFrom: 'source',
    })
    expect(
      remote.fetch.mock.calls.some(([url]) => String(url).includes('/upload/'))
    ).toBe(false)
  })

  it.each([
    [
      'a conflicting public marker',
      { runmeDerivedFrom: 'other' },
      legacyContent(),
    ],
    [
      'an ordinary unmarked notebook',
      {},
      '{"nbformat":4,"cells":[],"metadata":{}}',
    ],
    [
      'another source in legacy provenance',
      {},
      legacyContent(driveFileUrl('other')),
    ],
    ['invalid JSON without a marker', {}, '{'],
  ])('refuses %s without writing', async (_name, properties, content) => {
    const remote = driveResponses(
      properties as Record<string, string>,
      content as string
    )
    await expect(
      new DriveNotebookStore(async () => 'end-user').getDerivedCopyTarget(
        copy,
        source
      )
    ).rejects.toThrow('refusing to overwrite')
    expect(
      remote.fetch.mock.calls.every(([, init]) => init?.method === 'GET')
    ).toBe(true)
  })

  it('migrates a matching legacy app marker even after an interrupted media upload', async () => {
    driveResponses()
    const store = new DriveNotebookStore(async () => 'end-user')
    vi.spyOn(store, 'getVersionMetadata')
      .mockResolvedValueOnce({
        appProperties: { runmeCreateOperationId: legacyOperation },
      })
      .mockResolvedValueOnce({ properties: { runmeDerivedFrom: 'source' } })
    const media = vi.spyOn(store, 'loadContent')
    await expect(
      store.getDerivedCopyTarget(copy, source)
    ).resolves.toMatchObject({ uri: copy })
    expect(media).not.toHaveBeenCalled()
  })

  it('does not adopt an unrelated file returned by a reserved-ID collision', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('already exists', { status: 409 }))
    const store = new DriveNotebookStore(async () => 'end-user')
    vi.spyOn(store, 'getMetadataIfExists').mockResolvedValue(target)
    vi.spyOn(store, 'getVersionMetadata').mockResolvedValue({
      properties: { runmeDerivedFrom: 'other' },
    })
    await expect(
      store.createContent(
        driveFolderUrl('parent'),
        'report.ipynb',
        legacyContent(),
        IPYNB_MIME_TYPE,
        { derivedFromSourceId: 'source', fileId: 'copy' }
      )
    ).rejects.toThrow('refusing to overwrite')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][1]?.method).toBe('POST')
  })

  it('rejects migration if Drive does not persist the marker', async () => {
    driveResponses()
    const store = new DriveNotebookStore(async () => 'end-user')
    vi.spyOn(store, 'getVersionMetadata').mockResolvedValue({})
    await expect(store.getDerivedCopyTarget(copy, source)).rejects.toThrow(
      'after migration'
    )
  })

  it('recovers an unconfirmed create using shared properties when private markers are invisible', async () => {
    const store = new DriveNotebookStore(async () => 'end-user')
    const search = vi
      .spyOn(store, 'search')
      .mockResolvedValue({ files: [{ id: 'copy' }] })
    vi.spyOn(store, 'getMetadataIfExists').mockResolvedValue(target)
    vi.spyOn(store, 'getVersionMetadata').mockResolvedValue({
      properties: { runmeDerivedFrom: 'source' },
    })
    expect(await store.waitForDerivedCopy(source)).toEqual(target)
    expect(search.mock.calls[0][0].q).toContain(
      "properties has { key='runmeDerivedFrom' and value='source' }"
    )
  })

  it.each([
    { files: [{ id: 'a' }, { id: 'b' }] },
    { files: [{ id: 'a' }], nextPageToken: 'more' },
    { files: [{ id: 'a' }], incompleteSearch: true },
  ])('refuses ambiguous or partial discovery', async (result) => {
    const store = new DriveNotebookStore(async () => 'end-user')
    vi.spyOn(store, 'search').mockResolvedValue(result)
    const get = vi.spyOn(store, 'getDerivedCopyTarget')
    await expect(store.waitForDerivedCopy(source)).rejects.toThrow(
      'unique Colab copy'
    )
    expect(get).not.toHaveBeenCalled()
  })
})
