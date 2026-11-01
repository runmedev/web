import { appLogger } from '../lib/logging/runtime'

/** Observe an await without changing its result, timeout, or retry semantics.
 * Names/attributes must describe operations, never their notebook payloads.
 */
export async function traceStorage<T>(
  operation: string,
  run: () => PromiseLike<T>,
  attributes: Record<string, unknown> = {}
): Promise<T> {
  const startedAt = performance.now()
  const attrs = { scope: 'storage.trace', operation, ...attributes }
  appLogger.info('Storage operation started', {
    attrs: { ...attrs, state: 'started' },
  })
  const timer = setTimeout(() => {
    appLogger.warn('Storage operation still waiting', {
      attrs: {
        ...attrs,
        state: 'waiting',
        elapsedMs: Math.round(performance.now() - startedAt),
      },
    })
  }, 5000)
  try {
    const result = await run()
    appLogger.info('Storage operation completed', {
      attrs: {
        ...attrs,
        state: 'completed',
        elapsedMs: Math.round(performance.now() - startedAt),
      },
    })
    return result
  } catch (error) {
    appLogger.error('Storage operation failed', {
      attrs: {
        ...attrs,
        state: 'failed',
        elapsedMs: Math.round(performance.now() - startedAt),
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
    })
    throw error
  } finally {
    clearTimeout(timer)
  }
}
