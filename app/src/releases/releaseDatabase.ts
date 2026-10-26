import { appLogger } from '../lib/logging/runtime'
import { readControlValue, writeControlValue } from './controlChunks'

const DEADLINE_MS = 5000

type Operation = 'open' | 'upgrade' | 'transaction' | 'get' | 'put' | 'commit'

/** Only standard browser error names are exposed. Error messages can contain
 * serialized values or keys, so retain those only as the in-memory cause.
 */
function browserErrorName(cause: unknown): string | undefined {
  if (!(cause instanceof DOMException)) return undefined
  const names = new Set([
    'AbortError',
    'ConstraintError',
    'DataCloneError',
    'DataError',
    'InvalidAccessError',
    'InvalidStateError',
    'NotFoundError',
    'NotReadableError',
    'QuotaExceededError',
    'ReadOnlyError',
    'SecurityError',
    'TimeoutError',
    'TransactionInactiveError',
    'UnknownError',
    'VersionError',
  ])
  return names.has(cause.name) ? cause.name : undefined
}

/** Distinguish a browser storage failure from a rejected coordination decision.
 * Only the former triggers automatic stable recovery. Never log stored values.
 */
export class ReleaseControlError extends Error {
  constructor(
    readonly stage: 'open' | 'read' | 'commit',
    readonly reason: 'blocked' | 'timeout' | 'failed',
    readonly operation: Operation = stage === 'read' ? 'get' : stage,
    readonly cause?: unknown
  ) {
    super(
      `Release settings ${stage} ${reason} (${operation}${browserErrorName(cause) ? ': ' + browserErrorName(cause) : ''}). Stored notebook data has not been removed.`
    )
    this.name = 'ReleaseControlError'
    appLogger.warn(this.message, {
      attrs: { scope: 'releases.control', ...this.diagnosticDetails },
    })
  }

  /** A bounded, value-free description safe for the pre-app startup trace. */
  get diagnosticDetails() {
    return {
      stage: this.stage,
      reason: this.reason,
      operation: this.operation,
      ...(browserErrorName(this.cause)
        ? { browserError: browserErrorName(this.cause) }
        : {}),
    }
  }
}

/** An open request cannot be cancelled. Close late connections, and abort late
 * upgrades so timed-out attempts never create a store or retain a connection.
 */
function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    let request: IDBOpenDBRequest
    const fail = (
      reason: 'blocked' | 'timeout' | 'failed',
      cause?: unknown,
      operation: Operation = 'open'
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        request?.transaction?.abort()
      } catch {
        /* A completed upgrade has no live transaction. */
      }
      reject(new ReleaseControlError('open', reason, operation, cause))
    }
    const timer = setTimeout(() => fail('timeout'), DEADLINE_MS)
    try {
      request = indexedDB.open(name)
      request.onblocked = () => fail('blocked')
      request.onerror = () => fail('failed', request.error)
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort()
          return
        }
        try {
          request.result.createObjectStore('state')
        } catch (error) {
          fail('failed', error, 'upgrade')
        }
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
    } catch (error) {
      fail('failed', error)
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
      let operation: Operation = 'transaction'
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
        () => fail(new ReleaseControlError(stage, 'timeout', operation)),
        DEADLINE_MS
      )
      try {
        tx = db.transaction('state', write ? 'readwrite' : 'readonly')
        tx.onabort = tx.onerror = () => {
          if (!settled)
            fail(new ReleaseControlError(stage, 'failed', operation, tx?.error))
        }
        tx.oncomplete = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        }
        const table = tx.objectStore('state')
        operation = 'get'
        const request = table.get('control')
        request.onerror = () =>
          fail(new ReleaseControlError('read', 'failed', 'get', request.error))
        const accept = (value: unknown) => {
          if (settled) return
          try {
            const next = mutate(value)
            result = next.result
            stage = 'commit'
            if (write) {
              operation = 'put'
              try {
                writeControlValue(table, next.state, db.version > 1, (error) =>
                  fail(
                    new ReleaseControlError('commit', 'failed', 'put', error)
                  )
                )
              } catch (error) {
                fail(new ReleaseControlError('commit', 'failed', 'put', error))
                return
              }
            }
            operation = 'commit'
          } catch (error) {
            fail(error)
          }
        }
        request.onsuccess = () => {
          if (!settled)
            readControlValue(table, request.result, accept, (error) =>
              fail(new ReleaseControlError('read', 'failed', 'get', error))
            )
        }
      } catch (error) {
        fail(new ReleaseControlError(stage, 'failed', operation, error))
      }
    })
  } finally {
    db.close()
  }
}

/** Only irrecoverable value reads qualify for quarantine. Transient errors,
 * missing records, and blocked opens must never discard coordination state.
 */
export function isUnreadableControl(error: unknown): boolean {
  return (
    error instanceof ReleaseControlError &&
    error.stage === 'read' &&
    error.operation === 'get' &&
    error.diagnosticDetails.browserError === 'NotReadableError'
  )
}

/** Caller must hold exclusive storage ownership and prove no other live tabs.
 * Rename rather than delete the damaged store; old version-1 readers are fenced
 * by the schema bump. Upgrade abort/timeout rolls back both rename and writes.
 */
export async function quarantineControlDatabase(
  name: string,
  state: unknown
): Promise<void> {
  const prior = await openDatabase(name)
  const version = prior.version
  prior.close()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const request = indexedDB.open(name, version + 1)
    const fail = (
      reason: 'failed' | 'blocked' | 'timeout',
      cause?: unknown
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        request.transaction?.abort()
      } catch {
        /* Already ended. */
      }
      reject(new ReleaseControlError('open', reason, 'upgrade', cause))
    }
    const timer = setTimeout(() => fail('timeout'), DEADLINE_MS)
    request.onerror = () => fail('failed', request.error)
    request.onblocked = () => fail('blocked')
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort()
        return
      }
      try {
        request.transaction!.objectStore('state').name =
          `unreadable-state-${version}`
        const table = request.result.createObjectStore('state')
        writeControlValue(table, state, true, (error) => fail('failed', error))
      } catch (error) {
        fail('failed', error)
      }
    }
    request.onsuccess = () => {
      request.result.close()
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
  })
}
