// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Manifest } from './control'
import { releaseTransaction } from './releaseDatabase'

vi.mock('./releaseDatabase', () => ({ releaseTransaction: vi.fn() }))
vi.mock('./releaseChanges', () => ({ notifyReleaseChange: vi.fn() }))
const id = `${'a'.repeat(40)}-${'b'.repeat(64)}`
let stored: unknown
const cache = new Map<string, Response>()
const manifest: Manifest = {
  format: 1,
  storageControlFormat: 1,
  releaseId: id,
  webCommit: 'a'.repeat(40),
  buildId: 'b'.repeat(64),
  buildInputsDigest: 'b'.repeat(64),
  publishedAt: '2026-10-30T00:00:00Z',
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
  storageCompatibilityId: 'runme-schema9-oplog2-payload1-console1',
  assets: ['app.js', 'owner.js'].map((path) => ({
    path,
    sha256: '0'.repeat(64),
    bytes: 0,
    requiredOffline: true,
  })),
}
beforeEach(() => {
  vi.resetModules()
  cache.clear()
  stored = undefined
  vi.mocked(releaseTransaction)
    .mockReset()
    .mockImplementation(async (_db, write, mutate) => {
      const next = mutate(structuredClone(stored))
      if (write) stored = next.state
      return next.result
    })
  vi.stubGlobal('navigator', {
    locks: { request: async (_key: string, run: () => unknown) => run() },
  })
  vi.stubGlobal('caches', {
    open: async (name: string) => ({
      match: async (path: string) => cache.get(name + path)?.clone(),
      put: async (path: string, response: Response) => {
        cache.set(name + path, response.clone())
      },
    }),
  })
  cache.set(
    `runme-release-v1-${id}/__runme-startup/${id}`,
    Response.json(manifest)
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const writes = () =>
  vi.mocked(releaseTransaction).mock.calls.filter((args) => args[1])

it('keeps candidates, readiness, errors and cancellation out of persistent settings', async () => {
  const { control, readControl } = await import('./control')
  await control((s) => {
    s.candidate = manifest
    s.ownerError = { message: 'temporary failure' }
  })
  expect((await readControl()).candidate?.releaseId).toBe(id)
  await control((s) => {
    delete s.candidate
    delete s.ownerError
  })
  expect(writes()).toHaveLength(0)
  expect(stored).toBeUndefined()
  expect(cache.size).toBe(1)
})
it('persists only small references and explicit selection changes, without rewriting on reads', async () => {
  const { control, readControl } = await import('./control')
  await control((s) => {
    s.active = { manifest, epoch: 1 }
  })
  expect(stored).toEqual({
    format: 2,
    revision: 1,
    selection: { kind: 'channel', name: 'stable' },
    active: { releaseId: id, epoch: 1 },
    previous: undefined,
  })
  await control(() => {})
  for (let i = 0; i < 3; i++)
    expect((await readControl()).active?.manifest).toEqual(manifest)
  expect(writes()).toHaveLength(1)
  await control((s) => {
    s.selection = { kind: 'pinned', releaseId: id }
  })
  expect(writes()).toHaveLength(2)
})
it('opens the same installed release when IDB is blocked, without repeated reads or repair writes', async () => {
  const { control } = await import('./control')
  await control((s) => {
    s.active = { manifest, epoch: 4 }
  })
  vi.resetModules()
  vi.mocked(releaseTransaction)
    .mockClear()
    .mockRejectedValue(new Error('get timeout'))
  const { readControl } = await import('./control')
  expect((await readControl()).active?.epoch).toBe(4)
  expect((await readControl()).active?.epoch).toBe(4)
  expect(releaseTransaction).toHaveBeenCalledTimes(1)
  expect(writes()).toHaveLength(0)
})
it('preserves a newer explicit selection even if its IDB write fails or an older write commits late', async () => {
  const { control } = await import('./control')
  await control((s) => {
    s.active = { manifest, epoch: 1 }
  })
  const older = structuredClone(stored)
  vi.mocked(releaseTransaction).mockImplementation(
    async (_db, write, mutate) => {
      if (write) throw new Error('commit timeout')
      return mutate(older).result
    }
  )
  await control((s) => {
    s.selection = { kind: 'channel', name: 'latest' }
  })
  vi.resetModules()
  const { readControl } = await import('./control')
  expect((await readControl()).selection).toEqual({
    kind: 'channel',
    name: 'latest',
  })
})
it('does not require a cached previous release to open the selected release', async () => {
  const { control, readControl } = await import('./control')
  await control((s) => {
    s.active = { manifest, epoch: 1 }
    s.previous = {
      manifest: {
        ...manifest,
        releaseId: `${'c'.repeat(40)}-${'d'.repeat(64)}`,
      },
      epoch: 0,
    }
  })
  expect((await readControl()).active?.manifest.releaseId).toBe(id)
})

it('uses defaults for a missing record and rejects malformed preferences without changing them', async () => {
  const { readControl } = await import('./control')
  expect((await readControl()).selection).toEqual({
    kind: 'channel',
    name: 'stable',
  })
  stored = { format: 2, active: { epoch: 9 } }
  await expect(readControl()).rejects.toThrow('Invalid release preferences')
  expect(writes()).toHaveLength(0)
})

it('bounds a stalled cache metadata lookup when IndexedDB has readable legacy preferences', async () => {
  vi.useFakeTimers()
  stored = {
    format: 1,
    selection: { kind: 'channel', name: 'stable' },
    active: { manifest, epoch: 7 },
    tabs: {},
  }
  vi.stubGlobal('caches', { open: () => new Promise(() => {}) })
  const { readControl } = await import('./control')
  const pending = readControl()
  await vi.advanceTimersByTimeAsync(1500)
  expect((await pending).active?.epoch).toBe(7)
  expect(writes()).toHaveLength(0)
})

it('leaves legacy owner settings readable when changing selection before migration', async () => {
  const old = { ...manifest, storageControlFormat: undefined }
  stored = {
    format: 1,
    selection: { kind: 'channel', name: 'stable' },
    active: { manifest: old, epoch: 1 },
    tabs: {},
  }
  const before = structuredClone(stored)
  const { control, readControl } = await import('./control')
  await control((s) => {
    s.selection = { kind: 'channel', name: 'latest' }
  })
  expect(writes()).toHaveLength(0)
  expect(stored).toEqual(before)
  expect((await readControl()).selection).toEqual({
    kind: 'channel',
    name: 'latest',
  })
})

it('ignores abandoned historical coordination without rewriting the original record', async () => {
  const active = {
    manifest: { ...manifest, storageControlFormat: undefined },
    epoch: 3,
  }
  stored = {
    format: 1,
    selection: { kind: 'channel', name: 'stable' },
    active,
    tabs: { departed: { epoch: 3, releaseId: id } },
    transition: {
      id: 'abandoned',
      target: manifest,
      epoch: 4,
      phase: 'handoff',
      participants: {},
    },
    candidate: manifest,
    ownerStartup: { releaseId: id, epoch: 4, phase: 'initializing' },
    ownerError: { message: 'old worker failed' },
  }
  const original = structuredClone(stored)
  const { readControl, control } = await import('./control')
  expect(await readControl()).toEqual({
    format: 1,
    selection: { kind: 'channel', name: 'stable' },
    active,
    previous: undefined,
    tabs: {},
  })
  // Recovery discovery is allowed, even when it retains the same channel.
  await control((state) => {
    state.candidate = manifest
  })
  expect((await readControl()).candidate).toEqual(manifest)
  expect((await readControl()).transition).toBeUndefined()
  expect(writes()).toHaveLength(0)
  expect(stored).toEqual(original)
})
