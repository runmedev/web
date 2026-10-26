import { appLogger } from '../lib/logging/runtime'

const DEADLINE_MS = 5000

/** Distinguish a browser storage failure from a rejected coordination decision.
 * Only the former triggers automatic stable recovery. Never log stored values.
 */
export class ReleaseControlError extends Error {
  constructor(
    readonly stage: 'open' | 'read' | 'commit',
    readonly reason: 'blocked' | 'timeout' | 'failed'
  ) {
    super(
      `Release settings ${stage} ${reason}. Stored notebook data has not been removed.`
    )
    this.name = 'ReleaseControlError'
    appLogger.warn(this.message, {
      attrs: { scope: 'releases.control', stage, reason },
    })
  }
}

/** An open request cannot be cancelled. Close late connections, and abort late
 * upgrades so timed-out attempts never create a store or retain a connection.
 */
function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    let request: IDBOpenDBRequest
    const fail = (reason: 'blocked' | 'timeout' | 'failed') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        request?.transaction?.abort()
      } catch {
        /* A completed upgrade has no live transaction. */
      }
      reject(new ReleaseControlError('open', reason))
    }
    const timer = setTimeout(() => fail('timeout'), DEADLINE_MS)
    try {
      request = indexedDB.open(name, 1)
      request.onblocked = () => fail('blocked')
      request.onerror = () => fail('failed')
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort()
          return
        }
        request.result.createObjectStore('state')
      }
      request.onsuccess = () => {
        const db = request.result
        if (settled) {
          db.close()
          return
        }
        settled = true
        clearTimeout(timer)
        db.onversionchange = () => db.close()
        resolve(db)
      }
    } catch {
      fail('failed')
    }
  })
}

/** Bound both open and transaction completion. On timeout abort before exposing
 * failure; ignore all late callbacks, including mutations. Success means the
 * transaction committed, never merely that its get/put request succeeded.
 */
export async function releaseTransaction<T>(
  name: string,
  write: boolean,
  mutate: (value: unknown) => { state: unknown; result: T }
): Promise<T> {
  const db = await openDatabase(name)
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      let tx: IDBTransaction | undefined
      let stage: 'read' | 'commit' = 'read'
      let result: T
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          tx?.abort()
        } catch {
          /* It may already have completed. */
        }
        reject(error)
      }
      const timer = setTimeout(
        () => fail(new ReleaseControlError(stage, 'timeout')),
        DEADLINE_MS
      )
      try {
        tx = db.transaction('state', write ? 'readwrite' : 'readonly')
        tx.onabort = tx.onerror = () => {
          if (!settled) fail(new ReleaseControlError(stage, 'failed'))
        }
        tx.oncomplete = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        }
        const table = tx.objectStore('state')
        const request = table.get('control')
        request.onerror = () => fail(new ReleaseControlError('read', 'failed'))
        request.onsuccess = () => {
          if (settled) return
          try {
            const next = mutate(request.result)
            result = next.result
            stage = 'commit'
            if (write) table.put(next.state, 'control')
          } catch (error) {
            fail(error)
          }
        }
      } catch {
        fail(new ReleaseControlError(stage, 'failed'))
      }
    })
  } finally {
    db.close()
  }
}
