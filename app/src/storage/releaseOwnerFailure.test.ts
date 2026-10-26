import { expect, it, vi } from 'vitest'

import { ReleaseControlError } from '../releases/releaseDatabase'
import { retireUnreadableOwner } from './releaseOwnerFailure'

const unreadable = () =>
  new ReleaseControlError(
    'read',
    'failed',
    'get',
    new DOMException('', 'NotReadableError')
  )
it('releases ownership only after admitted writes finish draining', async () => {
  let finish!: () => void
  const runtime = {
    drain: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    ),
    close: vi.fn(),
  }
  const release = vi.fn()
  const pending = retireUnreadableOwner(unreadable(), runtime, release)
  expect(release).not.toHaveBeenCalled()
  finish()
  await expect(pending).resolves.toBe(true)
  expect(runtime.close).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
})
it('retains ownership after a failed drain or a transient storage failure', async () => {
  const runtime = {
    drain: vi.fn().mockRejectedValue(new Error('write pending')),
    close: vi.fn(),
  }
  const release = vi.fn()
  await expect(
    retireUnreadableOwner(unreadable(), runtime, release)
  ).rejects.toThrow('write pending')
  await expect(
    retireUnreadableOwner(
      new ReleaseControlError('read', 'timeout'),
      runtime,
      release
    )
  ).resolves.toBe(false)
  expect(runtime.close).not.toHaveBeenCalled()
  expect(release).not.toHaveBeenCalled()
})
