import { afterEach, expect, it, vi } from 'vitest'

import { type Control, pruneUnusedCaches } from './control'
import { holdReleaseCache, releaseCacheLock } from './releaseCacheLease'
import { releaseTransaction } from './releaseDatabase'

vi.mock('./releaseDatabase', () => ({ releaseTransaction: vi.fn() }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** Model only shared leases and nonblocking exclusive probes; cleanup must not
 * infer that a live release is unused just because no IDB tab record exists.
 */
it('retains a release until its last tab lease closes, without writing settings', async () => {
  const id = `${'a'.repeat(40)}-${'b'.repeat(64)}`
  const name = `runme-release-v1-${id}`
  const held = new Map<string, number>()
  vi.stubGlobal('navigator', {
    locks: {
      request: async (key: string, options: any, callback?: any) => {
        if (typeof options === 'function') return options({ name: key })
        if (options.ifAvailable && held.get(key)) return callback(null)
        held.set(key, (held.get(key) ?? 0) + 1)
        try {
          return await callback({ name: key })
        } finally {
          held.set(key, held.get(key)! - 1)
        }
      },
    },
  })
  const state: Control = {
    format: 1,
    selection: { kind: 'channel', name: 'stable' },
    tabs: {},
  }
  vi.mocked(releaseTransaction).mockImplementation(
    async (_name, _write, mutate) => mutate(state).result
  )
  const remove = vi.fn(async () => true)
  vi.stubGlobal('caches', {
    keys: async () => [name],
    delete: remove,
    open: async () => ({ match: async () => undefined }),
  })
  const first = await holdReleaseCache(id)
  const second = await holdReleaseCache(id)
  expect(held.get(releaseCacheLock(id))).toBe(2)
  expect(await pruneUnusedCaches()).toBe(0)
  first()
  await Promise.resolve()
  expect(await pruneUnusedCaches()).toBe(0)
  second()
  await Promise.resolve()
  expect(await pruneUnusedCaches()).toBe(1)
  expect(remove).toHaveBeenCalledTimes(1)
  expect(remove).toHaveBeenCalledWith(name)
  expect(
    vi.mocked(releaseTransaction).mock.calls.every((args) => args[1] === false)
  ).toBe(true)
})
