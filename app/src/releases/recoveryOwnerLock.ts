import { OWNER_LOCK } from './control'

/** Failed module startup can precede the old owner's final drain. Wait for the
 * real lock release; never steal it, and do not strand the recovery UI forever.
 */
export async function withRecoveryOwner<T>(
  action: () => Promise<T>,
  timeoutMs = 10000
): Promise<T> {
  const abort = new AbortController()
  let acquired = false
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    return await navigator.locks.request(
      OWNER_LOCK,
      { signal: abort.signal },
      async () => {
        acquired = true
        clearTimeout(timer)
        return action()
      }
    )
  } catch (error) {
    if (!acquired && abort.signal.aborted)
      throw new Error(
        'The storage worker is still draining. Wait, then retry recovery; no storage ownership was forced.'
      )
    throw error
  } finally {
    clearTimeout(timer)
  }
}
