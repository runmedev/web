import { afterEach, expect, it, vi } from 'vitest'

import { notifyReleaseChange } from './releaseChanges'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('treats a failed notification as a hint failure, not a failed durable write', () => {
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      constructor() {
        throw new Error('unavailable')
      }
    }
  )
  expect(() => notifyReleaseChange()).not.toThrow()
})

it('only observes change hints and can unsubscribe', async () => {
  const channel = new EventTarget()
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      constructor() {
        return channel
      }
    }
  )
  const { subscribeReleaseChanges } = await import('./releaseChanges')
  const listener = vi.fn()
  const unsubscribe = subscribeReleaseChanges(listener)
  channel.dispatchEvent(new MessageEvent('message', { data: 'activate' }))
  expect(listener).not.toHaveBeenCalled()
  channel.dispatchEvent(new MessageEvent('message', { data: 'changed' }))
  expect(listener).toHaveBeenCalledOnce()
  unsubscribe()
  channel.dispatchEvent(new MessageEvent('message', { data: 'changed' }))
  expect(listener).toHaveBeenCalledOnce()
})
