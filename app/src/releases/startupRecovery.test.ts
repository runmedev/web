import { afterEach, expect, it, vi } from 'vitest'

import { control, discover, stage } from './control'
import { ReleaseControlError } from './releaseDatabase'
import { prepareStartupRecovery } from './startupRecovery'

vi.mock('./control', () => ({
  control: vi.fn(),
  discover: vi.fn(),
  stage: vi.fn(),
}))
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

function setup() {
  const candidate = { releaseId: 'stable-release' } as any
  vi.mocked(discover).mockResolvedValue(candidate)
  vi.mocked(stage).mockResolvedValue(undefined)
  vi.stubGlobal('navigator', {
    locks: {
      request: async (_: string, __: unknown, run: () => unknown) => run(),
    },
  })
  return candidate
}
it('downloads stable before accessing settings and preserves active owners and transitions', async () => {
  const candidate = setup()
  const state: any = {
    selection: { kind: 'pinned', releaseId: 'old' },
    active: { epoch: 5 },
    transition: { phase: 'handoff' },
    tabs: { live: {} },
  }
  const before = structuredClone(state)
  vi.mocked(control).mockImplementation(async (mutate) => {
    expect(stage).toHaveBeenCalledWith(candidate, undefined, 'all')
    return mutate(state)
  })
  await expect(prepareStartupRecovery()).resolves.toBe(candidate)
  expect(discover).toHaveBeenCalledWith({ kind: 'channel', name: 'stable' })
  expect(state).toEqual({
    ...before,
    selection: { kind: 'channel', name: 'stable' },
    candidate,
  })
})
it('retries a storage failure using the original coordination database', async () => {
  setup()
  vi.mocked(control)
    .mockRejectedValueOnce(new ReleaseControlError('open', 'timeout'))
    .mockResolvedValue(undefined)
  await prepareStartupRecovery()
  expect(control).toHaveBeenCalledTimes(2)
  expect(stage).toHaveBeenCalledOnce()
})
it('stops after bounded attempts if storage never recovers', async () => {
  setup()
  vi.mocked(control).mockRejectedValue(
    new ReleaseControlError('read', 'timeout')
  )
  await expect(prepareStartupRecovery()).rejects.toBeInstanceOf(
    ReleaseControlError
  )
  expect(control).toHaveBeenCalledTimes(2)
})
it('does not overwrite settings after an offline or unverified download', async () => {
  setup()
  vi.mocked(stage).mockRejectedValue(new Error('checksum mismatch'))
  await expect(prepareStartupRecovery()).rejects.toThrow('checksum mismatch')
  expect(control).not.toHaveBeenCalled()
})
it('accepts an explicit alternative to stable and never retries coordination errors', async () => {
  setup()
  vi.mocked(control).mockRejectedValue(new Error('Unsupported format'))
  const selection = { kind: 'channel', name: 'latest' } as const
  await expect(prepareStartupRecovery(selection)).rejects.toThrow(
    'Unsupported format'
  )
  expect(discover).toHaveBeenCalledWith(selection)
  expect(control).toHaveBeenCalledOnce()
})
