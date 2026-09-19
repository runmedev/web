// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SESSION_RECORD_PREFIX } from './sessionStorageKeys'
import {
  __resetTabIdForTests,
  createSessionId,
  ensureSessionQueryParam,
  getClaimedSessionId,
  getSessionId,
  hasSessionLock,
} from './tabIdentity'

describe('tab identity', () => {
  const originalLocksDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    'locks'
  )

  afterEach(() => {
    __resetTabIdForTests()
    window.sessionStorage.clear()
    window.localStorage.clear()
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
    window.sessionStorage.setItem('runme/sessionId', 'amber-anchor')
    const randomValues = [1, 1]
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
    expect(window.sessionStorage.getItem('runme/sessionId')).toBe('blue-beacon')
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
  it('generates a readable ID without the secure-context randomUUID API', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      undefined as never
    )
    // In insecure contexts getRandomValues remains available but randomUUID does not.
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    })
    expect(createSessionId()).toMatch(/^[a-z]+-[a-z]+$/)
  })
  /** Deterministic randomness makes collisions reproducible instead of probabilistic. */
  function alwaysChooseFirstName() {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint32Array) array[0] = 0
        return array
      }
    )
  }

  /** Grant gates and lifetime locks, optionally racing a write before ownership. */
  function installLocks(beforeGrant?: (name: string) => boolean) {
    const request = vi.fn(
      async (
        name: string,
        _options: LockOptions,
        callback: LockGrantedCallback
      ) => {
        const available = beforeGrant?.(name) ?? true
        return callback(
          available ? ({ name, mode: 'exclusive' } as Lock) : null
        )
      }
    )
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    })
    return request
  }

  it('skips saved names, including corrupt records, without changing them', async () => {
    alwaysChooseFirstName()
    installLocks()
    localStorage.setItem(
      SESSION_RECORD_PREFIX + 'amber-anchor',
      'corrupt but reserved'
    )
    localStorage.setItem(SESSION_RECORD_PREFIX + 'amber-beacon', '{}')
    expect(await getClaimedSessionId()).toBe('amber-brook')
    expect(hasSessionLock()).toBe(true)
    expect(localStorage.getItem(SESSION_RECORD_PREFIX + 'amber-anchor')).toBe(
      'corrupt but reserved'
    )
  })

  it('rechecks saved names under the lock before claiming a generated ID', async () => {
    alwaysChooseFirstName()
    installLocks((name) => {
      if (name === 'runme:session:amber-anchor') {
        localStorage.setItem(
          SESSION_RECORD_PREFIX + 'amber-anchor',
          'created by another tab'
        )
      }
      return true
    })
    expect(getSessionId()).toBe('amber-anchor')
    expect(await getClaimedSessionId()).toBe('amber-beacon')
    expect(hasSessionLock()).toBe(true)
    expect(localStorage.getItem(SESSION_RECORD_PREFIX + 'amber-anchor')).toBe(
      'created by another tab'
    )
  })

  it('retries active names without looping on repeated random values', async () => {
    alwaysChooseFirstName()
    installLocks((name) => name !== 'runme:session:amber-anchor')
    expect(await getClaimedSessionId()).toBe('amber-beacon')
    expect(hasSessionLock()).toBe(true)
  })

  it('keeps retrying after more than eight active-name collisions', async () => {
    alwaysChooseFirstName()
    let occupied = 0
    installLocks(
      (name) => !name.startsWith('runme:session:') || occupied++ >= 10
    )
    expect(await getClaimedSessionId()).toBe('amber-forge')
    expect(hasSessionLock()).toBe(true)
  })

  it('falls back without durable access if the lock API rejects requests', async () => {
    alwaysChooseFirstName()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: vi.fn().mockRejectedValue(new Error('disabled')) },
    })
    expect(await getClaimedSessionId()).toBe('amber-beacon')
    expect(hasSessionLock()).toBe(false)
  })

  it.each(['sharp-pebble', 'blue-brook-5a892bdc-35e3-4694-a49a-1ba4db2f695c'])(
    'allows an explicit URL to resume its existing record: %s',
    async (id) => {
      installLocks()
      localStorage.setItem(SESSION_RECORD_PREFIX + id, '{}')
      history.replaceState(null, '', '/?session=' + id)
      expect(await getClaimedSessionId()).toBe(id)
      expect(hasSessionLock()).toBe(true)
    }
  )

  it('uses more words when all two-word names are reserved', () => {
    alwaysChooseFirstName()
    for (let i = 0; i < 720; i++) {
      const name = createSessionId()
      expect(name).toMatch(/^[a-z]+-[a-z]+$/)
      localStorage.setItem(SESSION_RECORD_PREFIX + name, '{}')
    }
    expect(createSessionId()).toBe('amber-amber-anchor')
  })

  it('keeps durable access disabled when name availability cannot be checked', async () => {
    alwaysChooseFirstName()
    installLocks()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('disabled')
    })
    expect(await getClaimedSessionId()).toMatch(/^[a-z]+-[a-z]+$/)
    expect(hasSessionLock()).toBe(false)
  })
})
