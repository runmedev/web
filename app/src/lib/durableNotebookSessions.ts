import { buildSessionLockName } from './tabIdentity'

export const SESSION_RECORD_PREFIX = 'runme/notebook-session/v1/'
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_INACTIVE_SESSIONS = 50
export const MAX_SESSION_BYTES = 64 * 1024

/** UI references only. Notebook contents, tokens and execution state live elsewhere. */
export interface DurableNotebookSession {
  version: 1
  lastActiveAt: number
  currentDoc: string | null
  openNotebooks: { uri: string; requestedUri: string; name: string }[]
}

/** Validate the entire record before hydrating UI state. Never partially overwrite it. */
export function parseDurableSession(
  raw: string | null
): DurableNotebookSession | null {
  if (!raw || raw.length * 2 > MAX_SESSION_BYTES) return null
  try {
    const value = JSON.parse(raw)
    if (
      value?.version !== 1 ||
      !Number.isFinite(value.lastActiveAt) ||
      value.lastActiveAt < 0 ||
      (value.currentDoc !== null && typeof value.currentDoc !== 'string') ||
      !Array.isArray(value.openNotebooks) ||
      !value.openNotebooks.every(
        (item: DurableNotebookSession['openNotebooks'][number]) =>
          item &&
          typeof item.uri === 'string' &&
          item.uri.startsWith('local://file/') &&
          typeof item.requestedUri === 'string' &&
          typeof item.name === 'string'
      )
    )
      return null
    return {
      version: 1,
      lastActiveAt: value.lastActiveAt,
      currentDoc: value.currentDoc,
      openNotebooks: value.openNotebooks.map(
        ({
          uri,
          requestedUri,
          name,
        }: DurableNotebookSession['openNotebooks'][number]) => ({
          uri,
          requestedUri,
          name,
        })
      ),
    }
  } catch {
    return null
  }
}

/** Storage access can throw in private/disabled-storage contexts. */
export function getDurableSessionStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Opportunistic GC: serialize collectors, then take each candidate's owner lock
 * before deleting. A stale timestamp never proves that a sleeping tab is dead.
 * All inspection/removal under a candidate lock is synchronous, so it cannot
 * race a new owner. No notebook file, OPFS content or auth key is touched.
 */
export async function collectInactiveNotebookSessions(
  storage: Storage,
  locks: LockManager,
  now = Date.now()
): Promise<void> {
  await locks.request(
    'runme:notebook-session-gc',
    { ifAvailable: true },
    async (gcLock) => {
      if (!gcLock) return
      const candidates: { key: string; time: number }[] = []
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (!key?.startsWith(SESSION_RECORD_PREFIX)) continue
        const record = parseDurableSession(storage.getItem(key))
        // Malformed v1 cache records are discardable; unrelated schema prefixes
        // are outside this collector. No arbitrary localStorage data is removed.
        candidates.push({ key, time: record?.lastActiveAt ?? 0 })
      }
      candidates.sort((a, b) => b.time - a.time)
      let retainedInactive = 0
      for (const candidate of candidates) {
        const id = candidate.key.slice(SESSION_RECORD_PREFIX.length)
        await locks.request(
          buildSessionLockName(id),
          { ifAvailable: true },
          (ownerLock) => {
            if (!ownerLock) return
            const record = parseDurableSession(storage.getItem(candidate.key))
            // A recently reopened-and-closed session may have changed since the
            // scan. Defer its ranking to the next pass instead of pruning fresh data.
            if (record && record.lastActiveAt !== candidate.time) return
            const expired =
              !record || now - record.lastActiveAt > SESSION_RETENTION_MS
            if (expired || retainedInactive >= MAX_INACTIVE_SESSIONS) {
              storage.removeItem(candidate.key)
            } else {
              retainedInactive++
            }
          }
        )
      }
    }
  )
}
