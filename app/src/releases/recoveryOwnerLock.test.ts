import { afterEach, expect, it, vi } from 'vitest'

import { withRecoveryOwner } from './recoveryOwnerLock'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('waits for the current owner to release instead of failing immediately', async () => {
  let grant!: () => void
  const action = vi.fn().mockResolvedValue('recovered')
  const request = vi.fn(
    (
      _name: string,
      options: { signal: AbortSignal },
      run: () => Promise<unknown>
    ) =>
      new Promise((resolve) => {
        grant = () => resolve(run())
        expect(options).not.toHaveProperty('ifAvailable')
        expect(options).not.toHaveProperty('steal')
      })
  )
  vi.stubGlobal('navigator', { locks: { request } })
  const pending = withRecoveryOwner(action)
  expect(action).not.toHaveBeenCalled()
  grant()
  await expect(pending).resolves.toBe('recovered')
})
it('bounds the wait without running the repair or evicting ownership', async () => {
  vi.useFakeTimers()
  const action = vi.fn()
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('', 'AbortError'))
          )
        ),
    },
  })
  const failed = expect(withRecoveryOwner(action, 100)).rejects.toThrow(
    'still draining'
  )
  await vi.advanceTimersByTimeAsync(100)
  await failed
  expect(action).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
