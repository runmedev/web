import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearGoogleDriveRuntime,
  setGoogleDriveBaseUrl,
} from '../../lib/googleDriveRuntime'
import {
  GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  type GoogleDriveResource,
} from './googleDriveBrowser'
import {
  type GoogleDriveResourcePath,
  resolveGoogleDriveResourcePaths,
} from './googleDrivePaths'

const roots = [
  { id: 'my-root', name: 'My Drive' },
  { id: 'shared', name: 'Engineering', driveId: 'shared' },
]
/** Search fixtures model ordinary folders unless explicitly overridden. */
const folder = (
  id: string,
  parents?: string[],
  extra: Partial<GoogleDriveResource> = {}
): GoogleDriveResource => ({
  id,
  name: 'Notebooks',
  mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
  parents,
  ...extra,
})
/** Routes metadata fixtures by ID and records every network lookup. */
function fixtureFetch(nodes: Record<string, unknown>) {
  return vi.fn<typeof fetch>(async (input) => {
    const id = decodeURIComponent(
      new URL(String(input)).pathname.split('/').at(-1)!
    )
    return new Response(JSON.stringify(nodes[id] ?? {}), {
      status: id in nodes ? 200 : 404,
    })
  })
}
/** Collects progressively published paths for assertions. */
async function resolve(
  resources: GoogleDriveResource[],
  fetchImpl = fixtureFetch({})
) {
  const paths: Record<string, GoogleDriveResourcePath> = {}
  await resolveGoogleDriveResourcePaths(
    'token',
    resources,
    roots,
    (id, path) => {
      paths[id] = path
    },
    new AbortController().signal,
    fetchImpl
  )
  return paths
}

describe('Google Drive search paths', () => {
  afterEach(() => {
    clearGoogleDriveRuntime()
    vi.useRealTimers()
  })

  it('resolves a shortcut to a root absent from the initial root list', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const isDrive = new URL(String(input)).pathname.includes('/drives/')
      return new Response(
        JSON.stringify(
          isDrive
            ? { id: 'outside', name: 'Other Drive' }
            : { id: 'outside', name: 'Root', driveId: 'outside' }
        )
      )
    })
    expect(
      (
        await resolve(
          [folder('outside', undefined, { isShortcut: true })],
          fetchImpl
        )
      ).outside
    ).toEqual({ label: 'Other Drive', complete: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('isolates forbidden, malformed JSON, and network errors to affected paths', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes('/forbidden?')) return new Response('', { status: 403 })
      if (url.includes('/malformed?')) return new Response('not JSON')
      throw new Error('network failure')
    })
    const paths = await resolve(
      [
        folder('a', ['forbidden']),
        folder('b', ['malformed']),
        folder('c', ['network']),
        folder('d', ['my-root']),
      ],
      fetchImpl
    )
    expect([
      paths.a.complete,
      paths.b.complete,
      paths.c.complete,
      paths.d.complete,
    ]).toEqual([false, false, false, true])
  })

  it('distinguishes duplicate names across roots and shares ancestor reads', async () => {
    const fetchImpl = fixtureFetch({
      team: {
        id: 'team',
        name: 'Runme',
        parents: ['shared'],
        driveId: 'shared',
      },
    })
    const paths = await resolve(
      [folder('a', ['team']), folder('b', ['team']), folder('c', ['my-root'])],
      fetchImpl
    )
    expect(paths).toEqual({
      a: { label: 'Engineering / Runme / Notebooks', complete: true },
      b: { label: 'Engineering / Runme / Notebooks', complete: true },
      c: { label: 'My Drive / Notebooks', complete: true },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('seeds ancestors from search results and recognizes known root results', async () => {
    const fetchImpl = fixtureFetch({})
    expect(
      await resolve(
        [
          folder('a', ['team']),
          folder('team', ['shared'], { name: 'Team' }),
          folder('shared'),
        ],
        fetchImpl
      )
    ).toEqual({
      a: { label: 'Engineering / Team / Notebooks', complete: true },
      team: { label: 'Engineering / Team', complete: true },
      shared: { label: 'Engineering', complete: true },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves unknown Shared Drive names once', async () => {
    const fetchImpl = fixtureFetch({
      outside: { id: 'outside', name: 'Other Drive' },
    })
    const paths = await resolve(
      [
        folder('a', ['outside'], { driveId: 'outside' }),
        folder('b', ['outside'], { driveId: 'outside' }),
      ],
      fetchImpl
    )
    expect(paths.a.label).toBe('Other Drive / Notebooks')
    expect(paths.b.complete).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(new URL(String(fetchImpl.mock.calls[0][0])).pathname).toBe(
      '/drive/v3/drives/outside'
    )
  })

  it('resolves a shortcut target path with its resource key, never its alias ancestry', async () => {
    setGoogleDriveBaseUrl('https://drive.example.test')
    const fetchImpl = fixtureFetch({
      target: {
        id: 'target',
        name: 'Canonical',
        parents: ['shared'],
        driveId: 'shared',
      },
    })
    const paths = await resolve(
      [
        folder('target', undefined, {
          isShortcut: true,
          name: 'Alias',
          resourceKey: 'key',
        }),
      ],
      fetchImpl
    )
    expect(paths.target).toEqual({
      label: 'Engineering / Canonical',
      complete: true,
    })
    const [input, options] = fetchImpl.mock.calls[0]
    const url = new URL(String(input))
    expect(url.origin).toBe('https://drive.example.test')
    expect(url.searchParams.get('fields')).toBe(
      'id,name,parents,driveId,resourceKey'
    )
    expect(url.searchParams.get('supportsAllDrives')).toBe('true')
    expect(options?.headers).toEqual({
      Authorization: 'Bearer token',
      'X-Goog-Drive-Resource-Keys': 'target/key',
    })
  })

  it('keeps failed and parentless paths partial without guessing My Drive', async () => {
    const fetchImpl = fixtureFetch({
      team: { id: 'team', name: 'Team', parents: ['missing'] },
      malformed: { id: 'wrong', name: 'Bad' },
    })
    const paths = await resolve(
      [
        folder('a', ['team']),
        folder('b', ['missing']),
        folder('c'),
        folder('d', ['malformed']),
        folder('target', undefined, { isShortcut: true }),
      ],
      fetchImpl
    )
    expect(paths.a).toEqual({
      label: '… / Team / Notebooks (partial path)',
      complete: false,
    })
    for (const id of ['b', 'c', 'd', 'target'])
      expect(paths[id]).toEqual({
        label: '… / Notebooks (partial path)',
        complete: false,
      })
    expect(
      fetchImpl.mock.calls.filter(([input]) =>
        String(input).includes('/missing?')
      )
    ).toHaveLength(1)
  })

  it('terminates cycles and limits ancestry depth', async () => {
    const cyclic = fixtureFetch({
      team: { id: 'team', name: 'Team', parents: ['a'] },
    })
    expect((await resolve([folder('a', ['team'])], cyclic)).a.complete).toBe(
      false
    )
    const deep = vi.fn<typeof fetch>(async (input) => {
      const id = new URL(String(input)).pathname.split('/').at(-1)!
      return new Response(
        JSON.stringify({ id, name: id, parents: [String(Number(id) + 1)] })
      )
    })
    expect((await resolve([folder('0', ['1'])], deep))['0'].complete).toBe(
      false
    )
    expect(deep).toHaveBeenCalledTimes(99)
  })

  it('publishes fast paths while slow paths load and caps network concurrency at six', async () => {
    const releases: Array<() => void> = []
    let pending = 0
    let peak = 0
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      pending++
      peak = Math.max(peak, pending)
      await new Promise<void>((resolve) => releases.push(resolve))
      pending--
      const id = new URL(String(input)).pathname.split('/').at(-1)!
      return new Response(JSON.stringify({ id, name: id, parents: ['shared'] }))
    })
    const onPath = vi.fn()
    const done = resolveGoogleDriveResourcePaths(
      'token',
      [
        folder('fast', ['my-root']),
        ...Array.from({ length: 12 }, (_, i) =>
          folder(`item-${i}`, [`parent-${i}`])
        ),
      ],
      roots,
      onPath,
      new AbortController().signal,
      fetchImpl
    )
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(6))
    expect(onPath).toHaveBeenCalledWith('fast', {
      label: 'My Drive / Notebooks',
      complete: true,
    })
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(12))
    releases.splice(0).forEach((release) => release())
    await done
    expect(peak).toBe(6)
    expect(onPath).toHaveBeenCalledTimes(13)
  })

  it('aborts pending requests and does not publish or schedule further work', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted'))
          )
        )
    )
    const onPath = vi.fn()
    const done = resolveGoogleDriveResourcePaths(
      'token',
      Array.from({ length: 10 }, (_, i) => folder(String(i), [`parent-${i}`])),
      roots,
      onPath,
      controller.signal,
      fetchImpl
    )
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(6))
    controller.abort()
    await done
    expect(fetchImpl).toHaveBeenCalledTimes(6)
    expect(onPath).not.toHaveBeenCalled()
  })

  it('times out unavailable metadata and allows a later search to retry', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('timeout'))
          )
        )
    )
    const done = resolve([folder('a', ['slow'])], fetchImpl)
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await done).a.complete).toBe(false)
    const retryFetch = fixtureFetch({
      slow: { id: 'slow', name: 'Now available', parents: ['my-root'] },
    })
    expect(
      (await resolve([folder('a', ['slow'])], retryFetch)).a.complete
    ).toBe(true)
  })
})
