import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  LAUNCHER_CACHE,
  LAUNCHER_POINTER,
  type LauncherDescriptor,
  launcherDescriptor,
  selectLauncher,
} from './launcherSelection'

const oldId = 'a'.repeat(40) + '-' + 'b'.repeat(64)
const newId = 'c'.repeat(40) + '-' + 'd'.repeat(64)
const code = 'export const launcher = 1'
let fallback: LauncherDescriptor
let latest: LauncherDescriptor
let stores: Map<string, Map<string, Response>>
let fetcher: ReturnType<typeof vi.fn>

/** CacheStorage fake preserves cloned responses and exposes interrupted writes. */
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('navigator', {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        run: () => Promise<void>
      ) => run(),
    },
  })
  const sha256 = Buffer.from(
    await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  ).toString('hex')
  fallback = {
    format: 1,
    protocol: 1,
    releaseId: oldId,
    entry: 'launcher.js',
    assets: [{ path: 'launcher.js', sha256, bytes: code.length }],
  }
  latest = { ...fallback, releaseId: newId }
  stores = new Map()
  vi.stubGlobal('caches', {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map())
      const store = stores.get(name)!
      return {
        match: async (key: string) => store.get(key)?.clone(),
        put: async (key: string, value: Response) => {
          store.set(key, value.clone())
        },
      }
    },
  })
  fetcher = vi.fn(
    async (url: string) =>
      new Response(url === '/launcher.json' ? JSON.stringify(latest) : code)
  )
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('chooses and caches latest independently of the embedded app release', async () => {
  expect(await selectLauncher(fallback, vi.fn())).toEqual({
    descriptor: latest,
    source: 'latest',
  })
  expect(
    await stores.get(LAUNCHER_CACHE)?.get(LAUNCHER_POINTER)?.json()
  ).toEqual(latest)
  expect(fetcher).toHaveBeenCalledWith(
    '/launcher.json',
    expect.objectContaining({ cache: 'no-store', redirect: 'error' })
  )
})
it('uses the latest complete cache offline without reading IndexedDB', async () => {
  await selectLauncher(fallback, vi.fn())
  fetcher.mockRejectedValue(new Error('offline'))
  expect(await selectLauncher(fallback, vi.fn())).toEqual({
    descriptor: latest,
    source: 'cached',
  })
})
it('falls back to the shell when the cached launcher has been evicted', async () => {
  await selectLauncher(fallback, vi.fn())
  stores.get(`runme-release-v1-${newId}`)!.clear()
  fetcher.mockRejectedValue(new Error('offline'))
  expect((await selectLauncher(fallback, vi.fn())).source).toBe('bundled')
})
it('never selects partial or corrupt downloads', async () => {
  fetcher.mockImplementation(
    async (url: string) =>
      new Response(
        url === '/launcher.json' ? JSON.stringify(latest) : 'corrupt'
      )
  )
  const report = vi.fn()
  expect((await selectLauncher(fallback, report)).descriptor).toEqual(fallback)
  expect(report).toHaveBeenCalledWith('Launcher verification failed')
  expect(stores.get(LAUNCHER_CACHE)?.has(LAUNCHER_POINTER)).not.toBe(true)
})
it('rejects incompatible future protocols and unsafe paths', () => {
  expect(() => launcherDescriptor({ ...latest, protocol: 2 })).toThrow()
  for (const path of ['../evil.js', '/evil.js', 'https://evil.test/code.js']) {
    expect(() =>
      launcherDescriptor({
        ...latest,
        entry: path,
        assets: [{ ...latest.assets[0], path }],
      })
    ).toThrow()
  }
})
it('bounds a hanging network check even when fetch ignores abort', async () => {
  vi.useFakeTimers()
  fetcher.mockReturnValue(new Promise(() => {}))
  const result = selectLauncher(fallback, vi.fn(), 50)
  await vi.advanceTimersByTimeAsync(50)
  expect((await result).source).toBe('bundled')
})
it('bounds an unresponsive cache and still starts the bundled launcher', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('caches', { open: () => new Promise(() => {}) })
  const result = selectLauncher(fallback, vi.fn(), 50)
  await vi.advanceTimersByTimeAsync(1050)
  expect((await result).source).toBe('bundled')
})
it('uses cached launchers when latest publication has an unsupported protocol', async () => {
  await selectLauncher(fallback, vi.fn())
  fetcher.mockResolvedValue(
    new Response(JSON.stringify({ ...latest, protocol: 2 }))
  )
  expect((await selectLauncher(fallback, vi.fn())).source).toBe('cached')
})

it('rejects corrupted cached bytes even when their completion marker remains', async () => {
  await selectLauncher(fallback, vi.fn())
  stores
    .get(`runme-release-v1-${newId}`)!
    .set(`/version/${newId}/launcher.js`, new Response('broken'))
  fetcher.mockRejectedValue(new Error('offline'))
  expect((await selectLauncher(fallback, vi.fn())).source).toBe('bundled')
})

it('reuses verified modules on refresh instead of downloading the app again', async () => {
  await selectLauncher(fallback, vi.fn())
  fetcher.mockClear()
  expect((await selectLauncher(fallback, vi.fn())).source).toBe('latest')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('retains the completed launcher after an interrupted replacement download', async () => {
  await selectLauncher(fallback, vi.fn())
  fetcher.mockImplementation(async (url: string) => {
    if (url === '/launcher.json') return new Response(JSON.stringify(fallback))
    throw new Error('download interrupted')
  })
  expect(await selectLauncher(fallback, vi.fn())).toEqual({
    descriptor: latest,
    source: 'cached',
  })
})
