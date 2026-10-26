import { isUnreadableControl } from '../releases/releaseDatabase'

/** An unreadable coordination record prevents all new admissions. Drain already
 * admitted work before relinquishing ownership; a failed drain keeps the lock.
 * Live tabs still block settings repair independently via their liveness locks.
 */
export async function retireUnreadableOwner(
  error: unknown,
  runtime: { drain(): Promise<unknown>; close(): void },
  release: () => void
): Promise<boolean> {
  if (!isUnreadableControl(error)) return false
  await runtime.drain()
  runtime.close()
  release()
  return true
}
