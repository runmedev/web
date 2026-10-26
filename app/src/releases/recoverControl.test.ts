import { afterEach, expect, it, vi } from 'vitest'

import { readControl } from './control'
import type { Manifest } from './control'
import { recoverUnreadableControl } from './recoverControl'
import {
  ReleaseControlError,
  quarantineControlDatabase,
} from './releaseDatabase'

vi.mock('./control', () => ({
  CONTROL_DB: 'test',
  OWNER_LOCK: 'owner',
  readControl: vi.fn(),
}))
vi.mock('./releaseDatabase', async (original) => ({
  ...(await original<typeof import('./releaseDatabase')>()),
  quarantineControlDatabase: vi.fn(),
}))
const candidate = { recoveredControlFormat: 1 } as Manifest
const selection = { kind: 'channel', name: 'stable' } as const
function setup(owner = true, otherTab = false) {
  vi.stubGlobal('navigator', {
    locks: {
      request: vi.fn(
        async (
          _name: string,
          options: unknown,
          callback?: (lock: unknown) => unknown
        ) =>
          callback ? callback(owner ? {} : null) : (options as () => unknown)()
      ),
      query: async () => ({
        held: [
          { name: 'runme-release-tab-self' },
          ...(otherTab ? [{ name: 'runme-release-tab-other' }] : []),
        ],
      }),
    },
  })
  vi.mocked(readControl).mockRejectedValue(
    new ReleaseControlError(
      'read',
      'failed',
      'get',
      new DOMException('', 'NotReadableError')
    )
  )
}
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})
it('quarantines only when no owner or other tab survives, using a fresh epoch', async () => {
  setup()
  await recoverUnreadableControl('self', selection, candidate)
  expect(quarantineControlDatabase).toHaveBeenCalledWith(
    'test',
    expect.objectContaining({
      selection,
      candidate,
      tabs: {},
      recoveredControlFormat: 1,
      epochBase: expect.any(Number),
    })
  )
})
it.each([
  [false, false],
  [true, true],
])('blocks repair with a live owner or tab (%s, %s)', async (owner, other) => {
  setup(owner, other)
  await expect(
    recoverUnreadableControl('self', selection, candidate)
  ).rejects.toThrow('close other Runme tabs')
  expect(quarantineControlDatabase).not.toHaveBeenCalled()
})
it('keeps recovered or transient state unchanged and rejects older releases', async () => {
  setup()
  vi.mocked(readControl).mockResolvedValueOnce({
    format: 1,
    selection,
    tabs: {},
  })
  await recoverUnreadableControl('self', selection, candidate)
  expect(quarantineControlDatabase).not.toHaveBeenCalled()
  vi.mocked(readControl).mockRejectedValueOnce(
    new ReleaseControlError('read', 'timeout')
  )
  await expect(
    recoverUnreadableControl('self', selection, candidate)
  ).rejects.toMatchObject({ reason: 'timeout' })
  await expect(
    recoverUnreadableControl('self', selection, {} as Manifest)
  ).rejects.toThrow('predates')
  expect(quarantineControlDatabase).not.toHaveBeenCalled()
})
