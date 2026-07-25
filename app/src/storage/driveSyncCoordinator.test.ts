/// <reference types="vitest" />
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { browserDriveSyncCoordinator } from './driveSyncCoordinator'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('browserDriveSyncCoordinator', () => {
  it('uses one named Web Lock per local notebook', async () => {
    const request = vi.fn(
      async (_name: string, operation: () => Promise<string>) => operation()
    )
    vi.stubGlobal('navigator', { locks: { request } })

    await expect(
      browserDriveSyncCoordinator.runExclusive(
        'local://file/notebook',
        async () => 'synced'
      )
    ).resolves.toBe('synced')

    expect(request).toHaveBeenCalledWith(
      'runme:drive-sync:local://file/notebook',
      expect.any(Function)
    )
  })
})
