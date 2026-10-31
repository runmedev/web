import Dexie, { type Transaction } from 'dexie'

import { appLogger } from './logging/runtime'

export const STORAGE_WAIT_MS = 1500
let sequence = 0

/** Bound optional persistence and report the exact pending stage without values,
 * source code, or keys. The signal fences late continuations as well as timeouts. */
export async function boundedStorage<T>(
  stage: string,
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  timeoutMs = STORAGE_WAIT_MS
): Promise<T> {
  const controller = new AbortController()
  const started = performance.now()
  const requestId = ++sequence
  const context = typeof document === 'undefined' ? 'worker' : 'window'
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => controller.abort(parent?.reason)
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  appLogger.debug('Storage operation started', {
    attrs: { scope: 'storage.optional', requestId, context, stage },
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return work(controller.signal)
      }),
      new Promise<never>((_, reject) => {
        const fail = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', fail, { once: true })
        if (controller.signal.aborted) fail()
        timer = setTimeout(
          () =>
            controller.abort(
              new DOMException(`Storage timeout: ${stage}`, 'TimeoutError')
            ),
          timeoutMs
        )
      }),
    ])
  } catch (error) {
    appLogger.warn('Storage operation unavailable', {
      attrs: {
        scope: 'storage.optional',
        requestId,
        context,
        stage,
        elapsedMs: Math.round(performance.now() - started),
        errorName: error instanceof Error ? error.name : 'unknown',
      },
    })
    throw error
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
    appLogger.debug('Storage operation settled', {
      attrs: {
        scope: 'storage.optional',
        requestId,
        context,
        stage,
        elapsedMs: Math.round(performance.now() - started),
      },
    })
  }
}

/** Abort a queued/active Dexie transaction when its deadline expires. A late
 * database open or transaction callback cannot authorize a write after timeout. */
export function boundedTransaction<T>(
  db: Dexie,
  mode: 'r' | 'rw',
  tables: string[],
  stage: string,
  action: () => Promise<T>,
  parent?: AbortSignal
): Promise<T> {
  return boundedStorage(
    `${db.name}.${stage}`,
    async (signal) => {
      await boundedStorage(
        `${db.name}.open`,
        async () => {
          await db.open()
        },
        signal
      )
      signal.throwIfAborted()
      let transaction: Transaction | undefined
      const abort = () => {
        try {
          transaction?.abort()
        } catch {
          /* Already settled. */
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        return await db.transaction(mode, tables, async () => {
          transaction = Dexie.currentTransaction!
          signal.throwIfAborted()
          appLogger.debug('Storage transaction executing', {
            attrs: {
              scope: 'storage.optional',
              database: db.name,
              stage,
              mode,
              stores: tables.join(','),
            },
          })
          return action()
        })
      } finally {
        signal.removeEventListener('abort', abort)
      }
    },
    parent
  )
}
