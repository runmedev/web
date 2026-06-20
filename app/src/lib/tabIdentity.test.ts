// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __resetTabIdForTests,
  ensureSessionQueryParam,
  getClaimedSessionId,
  getSessionId,
} from './tabIdentity'

describe('tab identity', () => {
  const originalLocksDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    'locks'
  )

  afterEach(() => {
    __resetTabIdForTests()
    window.sessionStorage.clear()
    window.history.replaceState(null, '', '/')
    vi.restoreAllMocks()
    if (originalLocksDescriptor) {
      Object.defineProperty(navigator, 'locks', originalLocksDescriptor)
    } else {
      Reflect.deleteProperty(navigator, 'locks')
    }
  })

  it('uses sessionStorage as the page-load session id source', async () => {
    window.sessionStorage.setItem('runme/sessionId', 'session-from-storage')
    window.history.replaceState(null, '', '/?session=session-from-url#cell-a')

    const sessionId = ensureSessionQueryParam()
    const claimed = await getClaimedSessionId()

    expect(sessionId).toBe('session-from-storage')
    expect(claimed).toBe(sessionId)
    expect(getSessionId()).toBe(sessionId)
    expect(window.location.search).toBe('?session=session-from-storage')
    expect(window.location.hash).toBe('#cell-a')
  })

  it('adds a session query parameter when the URL does not have one', async () => {
    window.history.replaceState(null, '', '/?doc=local%3A%2F%2Fnote#section')

    const sessionId = ensureSessionQueryParam()
    const claimed = await getClaimedSessionId()

    expect(sessionId).toBeTruthy()
    expect(claimed).toBe(sessionId)
    expect(sessionId).toMatch(/^[a-z]+-[a-z]+$/)
    expect(window.sessionStorage.getItem('runme/sessionId')).toBe(sessionId)
    expect(window.location.search).toContain('doc=local%3A%2F%2Fnote')
    expect(window.location.search).toContain(
      `session=${encodeURIComponent(sessionId)}`
    )
    expect(window.location.hash).toBe('#section')
  })

  it('retries with a new readable session id when another tab holds the lock', async () => {
    const randomValues = [0, 0, 1, 1]
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint32Array) {
          array[0] = randomValues.shift() ?? 0
        }
        return array
      }
    )

    const request = vi.fn(
      async (
        name: string,
        _options: LockOptions,
        callback: LockGrantedCallback
      ) => {
        if (name === 'runme:session:amber-anchor') {
          return callback(null)
        }
        return callback({ name, mode: 'exclusive' } as Lock)
      }
    )
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    })

    const initial = ensureSessionQueryParam()
    const claimed = await getClaimedSessionId()

    expect(initial).toBe('amber-anchor')
    expect(claimed).toBe('blue-beacon')
    expect(window.sessionStorage.getItem('runme/sessionId')).toBe(
      'blue-beacon'
    )
    expect(window.location.search).toBe('?session=blue-beacon')
    expect(request).toHaveBeenCalledWith(
      'runme:session:amber-anchor',
      { ifAvailable: true },
      expect.any(Function)
    )
    expect(request).toHaveBeenCalledWith(
      'runme:session:blue-beacon',
      { ifAvailable: true },
      expect.any(Function)
    )
  })
})
