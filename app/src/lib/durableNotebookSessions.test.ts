// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_INACTIVE_SESSIONS,
  MAX_SESSION_BYTES,
  SESSION_RECORD_PREFIX,
  SESSION_RETENTION_MS,
  collectInactiveNotebookSessions,
  parseDurableSession,
} from './durableNotebookSessions'
import { NotebookSessionPersistence } from './notebookSessionPersistence'
import {
  __resetTabIdForTests,
  buildSessionClaimLockName,
  getClaimedSessionId,
  hasSessionLock,
} from './tabIdentity'

/** Hold locks until their callbacks settle, just as browser Web Locks do. */
function mockLocks() {
  const held = new Set<string>()
  const waiters = new Map<string, (() => void)[]>()
  const request = vi.fn(
    async (
      name: string,
      options: LockOptions,
      callback: LockGrantedCallback
    ) => {
      while (held.has(name)) {
        if (options.ifAvailable) return callback(null)
        await new Promise<void>((resolve) =>
          waiters.set(name, [...(waiters.get(name) ?? []), resolve])
        )
      }
      held.add(name)
      try {
        return await callback({ name, mode: 'exclusive' } as Lock)
      } finally {
        held.delete(name)
        const pending = waiters.get(name) ?? []
        waiters.delete(name)
        pending.forEach((resolve) => resolve())
      }
    }
  )
  const locks = { request } as unknown as LockManager
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: locks,
  })
  return { held, locks }
}

const entry = {
  uri: 'local://file/one',
  requestedUri: 'local://file/one',
  name: 'one.runme',
  state: 'loaded' as const,
}
const now = 1_800_000_000_000
function record(lastActiveAt = now) {
  return {
    version: 1,
    lastActiveAt,
    currentDoc: entry.uri,
    openNotebooks: [entry],
  }
}
const key = (id: string) => SESSION_RECORD_PREFIX + id

describe('durable notebook sessions', () => {
  let manager: ReturnType<typeof mockLocks>
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
    history.replaceState(null, '', '/')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    manager = mockLocks()
  })
  afterEach(() => {
    __resetTabIdForTests()
    vi.restoreAllMocks()
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
  })

  it('restores from the saved URL after sessionStorage was lost, before any save', async () => {
    localStorage.setItem(key('gold-pebble'), JSON.stringify(record()))
    history.replaceState(null, '', '/?session=gold-pebble')
    const id = await getClaimedSessionId()
    expect(id).toBe('gold-pebble')
    const persistence = new NotebookSessionPersistence()
    persistence.enableDurable(id)
    expect(persistence.loadCurrentDoc()).toBe(entry.uri)
    expect(persistence.loadOpenNotebooks()).toEqual([
      { ...entry, state: 'loading' },
    ])
    persistence.saveCurrentDoc(null)
    persistence.saveOpenNotebooks([])
    expect(JSON.parse(localStorage.getItem(key(id))!)).toMatchObject({
      currentDoc: null,
      openNotebooks: [],
    })
  })

  it('forks a copied URL and cloned sessionStorage without reading or overwriting the owner', async () => {
    const original = JSON.stringify(record())
    localStorage.setItem(key('gold-pebble'), original)
    sessionStorage.setItem('runme/sessionId', 'gold-pebble')
    sessionStorage.setItem('runme/openNotebooks', JSON.stringify([entry]))
    sessionStorage.setItem('runme/currentDoc', entry.uri)
    sessionStorage.setItem('runme/workspaceDocuments', JSON.stringify([entry]))
    manager.held.add('runme:session:gold-pebble')
    history.replaceState(null, '', '/?session=gold-pebble')
    const id = await getClaimedSessionId()
    expect(id).not.toBe('gold-pebble')
    expect(sessionStorage.getItem('runme/workspaceDocuments')).toBeNull()
    const persistence = new NotebookSessionPersistence()
    persistence.enableDurable(id)
    expect(persistence.loadOpenNotebooks()).toEqual([])
    expect(persistence.loadCurrentDoc()).toBeNull()
    persistence.saveOpenNotebooks([])
    expect(localStorage.getItem(key('gold-pebble'))).toBe(original)
  })

  it('migrates the surviving legacy tab, projecting references and excluding runtime ownership', async () => {
    sessionStorage.setItem('runme/sessionId', 'legacy-session')
    sessionStorage.setItem(
      'runme/openNotebooks',
      JSON.stringify([
        {
          ...entry,
          owner: { token: 'not-persisted' },
          errorMessage: 'transient',
        },
      ])
    )
    sessionStorage.setItem('runme/currentDoc', entry.uri)
    const id = await getClaimedSessionId()
    const persistence = new NotebookSessionPersistence()
    persistence.enableDurable(id)
    expect(JSON.parse(localStorage.getItem(key(id))!).openNotebooks).toEqual([
      { uri: entry.uri, requestedUri: entry.requestedUri, name: entry.name },
    ])
  })

  it('never reads or writes shared restore state without a lock', async () => {
    Reflect.deleteProperty(navigator, 'locks')
    localStorage.setItem(key('gold-pebble'), JSON.stringify(record()))
    history.replaceState(null, '', '/?session=gold-pebble')
    const id = await getClaimedSessionId()
    expect(id).not.toBe('gold-pebble')
    expect(hasSessionLock()).toBe(false)
    const persistence = new NotebookSessionPersistence()
    persistence.enableDurable(id)
    expect(persistence.loadOpenNotebooks()).toEqual([])
    persistence.saveOpenNotebooks([entry])
    expect(localStorage.getItem(key(id))).toBeNull()
  })

  it('falls back to a fresh ephemeral identity on lock API failure', async () => {
    vi.spyOn(manager.locks, 'request').mockRejectedValue(
      new Error('unavailable')
    )
    history.replaceState(null, '', '/?session=gold-pebble')
    expect(await getClaimedSessionId()).not.toBe('gold-pebble')
    expect(hasSessionLock()).toBe(false)
  })

  it('stops durable writes after pagehide releases ownership', async () => {
    const id = await getClaimedSessionId()
    const persistence = new NotebookSessionPersistence()
    persistence.enableDurable(id)
    const saved = localStorage.getItem(key(id))
    window.dispatchEvent(new Event('pagehide'))
    persistence.saveOpenNotebooks([entry])
    expect(hasSessionLock()).toBe(false)
    expect(localStorage.getItem(key(id))).toBe(saved)
  })

  it('preserves malformed records while allowing tab-local use', async () => {
    const id = await getClaimedSessionId()
    localStorage.setItem(key(id), '{bad')
    const persistence = new NotebookSessionPersistence()
    persistence.enableDurable(id)
    persistence.saveOpenNotebooks([entry])
    expect(persistence.loadOpenNotebooks()).toHaveLength(1)
    expect(localStorage.getItem(key(id))).toBe('{bad')
    expect(
      parseDurableSession(JSON.stringify({ ...record(), currentDoc: {} }))
    ).toBeNull()
    expect(parseDurableSession('x'.repeat(MAX_SESSION_BYTES))).toBeNull()
  })

  it('does not resurrect an expired durable session from a stale sessionStorage cache', async () => {
    const id = await getClaimedSessionId()
    localStorage.setItem(
      key(id),
      JSON.stringify(record(now - SESSION_RETENTION_MS - 1))
    )
    sessionStorage.setItem('runme/openNotebooks', JSON.stringify([entry]))
    sessionStorage.setItem('runme/workspaceDocuments', JSON.stringify([entry]))
    const persistence = new NotebookSessionPersistence()
    persistence.enableDurable(id)
    expect(persistence.loadOpenNotebooks()).toEqual([])
    expect(sessionStorage.getItem('runme/workspaceDocuments')).toBeNull()
  })

  it('expires records after seven days but preserves stale locked sessions and notebook data', async () => {
    localStorage.setItem(
      key('expired'),
      JSON.stringify(record(now - 8 * 24 * 60 * 60 * 1000))
    )
    localStorage.setItem(
      key('sleeping'),
      JSON.stringify(record(now - 8 * 24 * 60 * 60 * 1000))
    )
    localStorage.setItem(
      key('recent'),
      JSON.stringify(record(now - 6 * 24 * 60 * 60 * 1000))
    )
    localStorage.setItem('runme/notebook-content', 'keep')
    manager.held.add('runme:session:sleeping')
    await collectInactiveNotebookSessions(localStorage, manager.locks, now)
    expect(localStorage.getItem(key('expired'))).toBeNull()
    expect(localStorage.getItem(key('recent'))).not.toBeNull()
    expect(localStorage.getItem(key('sleeping'))).not.toBeNull()
    expect(localStorage.getItem('runme/notebook-content')).toBe('keep')
  })

  it('caps inactive records by recency while exempting active records', async () => {
    for (let i = 0; i < MAX_INACTIVE_SESSIONS + 3; i++) {
      localStorage.setItem(key(`id-${i}`), JSON.stringify(record(now - i)))
    }
    manager.held.add('runme:session:id-52')
    await collectInactiveNotebookSessions(localStorage, manager.locks, now)
    expect(localStorage.length).toBe(MAX_INACTIVE_SESSIONS + 1)
    expect(localStorage.getItem(key('id-50'))).toBeNull()
    expect(localStorage.getItem(key('id-52'))).not.toBeNull()
  })

  it('checks ownership again for a session claimed after the cleanup scan', async () => {
    localStorage.setItem(
      key('expired'),
      JSON.stringify(record(now - SESSION_RETENTION_MS - 1))
    )
    const real = manager.locks.request.bind(manager.locks)
    vi.spyOn(manager.locks, 'request').mockImplementation(((
      name: string,
      options: LockOptions,
      cb: LockGrantedCallback
    ) => {
      if (name === 'runme:session:expired') manager.held.add(name)
      return real(name, options, cb)
    }) as LockManager['request'])
    await collectInactiveNotebookSessions(localStorage, manager.locks, now)
    expect(localStorage.getItem(key('expired'))).not.toBeNull()
  })
  it('honors explicit empty same-tab state over an older durable snapshot on reload', async () => {
    localStorage.setItem(key('gold-pebble'), JSON.stringify(record()))
    history.replaceState(null, '', '/?session=gold-pebble')
    sessionStorage.setItem('runme/openNotebooks', '[]')
    sessionStorage.setItem('runme/currentDoc', '')
    const persistence = new NotebookSessionPersistence()
    persistence.enableDurable(await getClaimedSessionId())
    expect(persistence.loadOpenNotebooks()).toEqual([])
    expect(persistence.loadCurrentDoc()).toBeNull()
  })

  it('projects validated records instead of retaining extra runtime fields', () => {
    expect(
      parseDurableSession(
        JSON.stringify({ ...record(), token: 'not-persisted' })
      )
    ).toEqual({
      version: 1,
      lastActiveAt: now,
      currentDoc: entry.uri,
      openNotebooks: [
        { uri: entry.uri, requestedUri: entry.uri, name: entry.name },
      ],
    })
  })

  it('keeps the workspace usable after durable quota errors', async () => {
    const id = await getClaimedSessionId()
    localStorage.setItem(key(id), JSON.stringify(record()))
    const persistence = new NotebookSessionPersistence()
    persistence.enableDurable(id)
    const previous = localStorage.getItem(key(id))
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      name,
      value
    ) {
      if (this === localStorage)
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      original.call(this, name, value)
    })
    expect(() => persistence.saveOpenNotebooks([])).not.toThrow()
    expect(persistence.loadOpenNotebooks()).toEqual([])
    expect(localStorage.getItem(key(id))).toBe(previous)
    expect(sessionStorage.getItem('runme/openNotebooks')).toBe('[]')
  })

  it('ignores invalid URL IDs', async () => {
    history.replaceState(null, '', '/?session=%3Cinvalid%3E')
    expect(await getClaimedSessionId()).not.toBe('<invalid>')
  })

  it('defers a session refreshed after the cleanup scan', async () => {
    localStorage.setItem(
      key('refreshed'),
      JSON.stringify(record(now - SESSION_RETENTION_MS - 1))
    )
    const real = manager.locks.request.bind(manager.locks)
    vi.spyOn(manager.locks, 'request').mockImplementation(((
      name: string,
      options: LockOptions,
      cb: LockGrantedCallback
    ) => {
      if (name === 'runme:session:refreshed')
        localStorage.setItem(key('refreshed'), JSON.stringify(record()))
      return real(name, options, cb)
    }) as LockManager['request'])
    await collectInactiveNotebookSessions(localStorage, manager.locks, now)
    expect(localStorage.getItem(key('refreshed'))).not.toBeNull()
  })
  it('waits for a short cleanup gate instead of forking a saved session', async () => {
    localStorage.setItem(key('gold-pebble'), JSON.stringify(record()))
    history.replaceState(null, '', '/?session=gold-pebble')
    let release!: () => void
    let acquired!: () => void
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve
    })
    const cleanup = manager.locks.request(
      buildSessionClaimLockName('gold-pebble'),
      {},
      async () => {
        // GC owns the temporary session lock while making its deletion decision.
        manager.held.add('runme:session:gold-pebble')
        acquired()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        manager.held.delete('runme:session:gold-pebble')
      }
    )
    await acquiredPromise
    const claiming = getClaimedSessionId()
    await Promise.resolve()
    release()
    await cleanup
    expect(await claiming).toBe('gold-pebble')
    const persistence = new NotebookSessionPersistence()
    persistence.enableDurable('gold-pebble')
    expect(persistence.loadCurrentDoc()).toBe(entry.uri)
  })

  it('skips collection while a new owner is claiming the session', async () => {
    localStorage.setItem(
      key('claiming'),
      JSON.stringify(record(now - SESSION_RETENTION_MS - 1))
    )
    manager.held.add(buildSessionClaimLockName('claiming'))
    await collectInactiveNotebookSessions(localStorage, manager.locks, now)
    expect(localStorage.getItem(key('claiming'))).not.toBeNull()
  })
})
