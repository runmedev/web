import { afterEach, expect, it, vi } from 'vitest'

import type { Control } from './control'
import { notifyReleaseChange, releaseChangeKey } from './releaseChanges'

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

it('does not wake peers for tab bookkeeping or readiness, but does for selection', () => {
  const state: Control = {
    format: 1,
    selection: { kind: 'channel', name: 'stable' },
    tabs: {},
  }
  const before = releaseChangeKey(state)
  state.tabs.editor = { epoch: 1, releaseId: 'installed' }
  state.healthy = 'installed'
  state.ownerStartup = { releaseId: 'installed', epoch: 1, phase: 'ready' }
  expect(releaseChangeKey(state)).toBe(before)
  state.selection = { kind: 'channel', name: 'latest' }
  expect(releaseChangeKey(state)).not.toBe(before)
})
