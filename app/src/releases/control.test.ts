// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type Manifest,
  STORAGE_COMPATIBILITY,
  digest,
  discover,
  stage,
  validateManifest,
  verifyCache,
} from './control'

async function fixture(): Promise<Manifest> {
  const hash = await digest(new TextEncoder().encode('verified').buffer)
  return {
    format: 1,
    releaseId: `${'a'.repeat(40)}-${'b'.repeat(64)}`,
    webCommit: 'a'.repeat(40),
    buildId: 'b'.repeat(64),
    buildInputsDigest: 'b'.repeat(64),
    publishedAt: '2026-10-24T00:00:00Z',
    requiredCapabilities: [
      'durable-prepare-v1',
      'epoch-fence-v1',
      'owner-lock-v1',
    ],
    testedRollbackTargets: [],
    launcherProtocol: { min: 1, max: 1 },
    appEntry: 'app.js',
    styles: [],
    owner: { buildId: 'b'.repeat(64), entry: 'owner.js', rpcMin: 8, rpcMax: 8 },
    storageCompatibilityId: STORAGE_COMPATIBILITY,
    assets: ['app.js', 'owner.js'].map((path) => ({
      path,
      sha256: hash,
      bytes: 8,
      requiredOffline: true,
    })),
  }
}
afterEach(() => vi.unstubAllGlobals())

describe('release eligibility and staging', () => {
  it('rejects archives, unsupported protocols, unsafe paths and missing entries', async () => {
    const m = await fixture()
    expect(validateManifest(m)).toBe(m)
    for (const change of [
      { format: 0 },
      { launcherProtocol: {} },
      { owner: {} },
      { storageCompatibilityId: 'old' },
      { releaseId: 'other' },
      { appEntry: 'missing.js' },
      { assets: [...m.assets, m.assets[0]] },
      { assets: [{ ...m.assets[0], path: '../app.js' }] },
    ])
      expect(() => validateManifest({ ...m, ...change })).toThrow()
  })

  it('never completes a corrupt/partial download and rechecks eviction before activation', async () => {
    const m = await fixture(),
      stored = new Map<string, Response>()
    const cache = {
      match: vi.fn(async (url: string) => stored.get(url)?.clone()),
      put: vi.fn(async (url: string, response: Response) => {
        stored.set(url, response.clone())
      }),
    }
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) })
    vi.stubGlobal('navigator', {
      locks: { request: async (_: string, fn: () => unknown) => fn() },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(url.endsWith('owner.js') ? 'tampered' : 'verified')
      )
    )
    await expect(stage(m)).rejects.toThrow('verification failed')
    expect([...stored.keys()].some((key) => key.endsWith('release.json'))).toBe(
      false
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('verified'))
    )
    await stage(m)
    await verifyCache(m)
    stored.delete(`/version/${m.releaseId}/owner.js`)
    await expect(verifyCache(m)).rejects.toThrow('cache incomplete')
    expect([...stored.keys()].some((key) => key.endsWith('release.json'))).toBe(
      true
    )
  })

  it('verifies the pointer digest and never consults channels for a pin', async () => {
    const m = await fixture()
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.startsWith('/channels/')
              ? {
                  format: 1,
                  generation: 1,
                  releaseId: m.releaseId,
                  manifestSha256: '0'.repeat(64),
                }
              : m
          )
        )
    )
    vi.stubGlobal('fetch', fetcher)
    await expect(discover({ kind: 'channel', name: 'stable' })).rejects.toThrow(
      'checksum'
    )
    fetcher.mockClear()
    expect(await discover({ kind: 'pinned', releaseId: m.releaseId })).toEqual(
      m
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe(
      `/version/${m.releaseId}/release.json`
    )
  })

  it('bounds concurrent downloads and drains a failed batch before allowing retry', async () => {
    const m = await fixture()
    m.assets.push(
      ...Array.from({ length: 10 }, (_, i) => ({
        ...m.assets[0],
        path: `chunk-${i}.js`,
      }))
    )
    const stored = new Map<string, Response>()
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (url: string) => stored.get(url)?.clone(),
        put: async (url: string, response: Response) => {
          stored.set(url, response.clone())
        },
      }),
    })
    let lockHeld = false
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_: string, fn: () => Promise<void>) => {
          lockHeld = true
          try {
            await fn()
          } finally {
            lockHeld = false
          }
        },
      },
    })
    const requests: Array<{
      resolve: (value: Response) => void
      reject: (error: Error) => void
    }> = []
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve, reject) => {
          requests.push({ resolve, reject })
        })
    )
    vi.stubGlobal('fetch', fetcher)
    const failed = stage(m).catch((error) => error)
    await vi.waitFor(() => expect(requests).toHaveLength(6))
    requests[0].reject(new Error('network unavailable'))
    await Promise.resolve()
    await Promise.resolve()
    expect(lockHeld).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(6)
    for (const request of requests.slice(1))
      request.resolve(new Response('verified'))
    expect(await failed).toMatchObject({ message: 'network unavailable' })
    expect(lockHeld).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(6)
    expect(stored.has(`/version/${m.releaseId}/release.json`)).toBe(false)

    fetcher.mockImplementation(async () => new Response('verified'))
    const progress = vi.fn()
    await stage(m, progress)
    await verifyCache(m)
    expect(progress).toHaveBeenLastCalledWith({ completed: 12, total: 12 })
    expect(stored.has(`/version/${m.releaseId}/release.json`)).toBe(true)
  })
})
