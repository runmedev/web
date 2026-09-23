import { appLogger } from '../lib/logging/runtime'
import type LocalNotebooks from './local'

export const DRIVE_RECONCILE_INTERVAL_MS = 2 * 60_000

/**
 * Wake the level-based reconciler while Drive auth is available. A wake-up never
 * owns pending work: persisted checksums/errors survive tab closure and reload.
 * Keep one pass active and retain an online wake-up that arrives during a pass.
 */
export function startDriveResyncReconciler(
  store: Pick<LocalNotebooks, 'reconcileDriveBackedFiles'>,
  options: { retryErrors?: boolean } = {}
): () => void {
  let stopped = false
  let running = false
  let wakeAgain = false
  const canRun = () => !stopped && navigator.onLine !== false
  const reconcile = async (retryErrors = false) => {
    if (!canRun()) return
    if (running) {
      wakeAgain = true
      return
    }
    running = true
    try {
      const queued = await store.reconcileDriveBackedFiles({
        retryErrors,
        shouldContinue: canRun,
      })
      appLogger.info('Drive reconciliation pass finished', {
        attrs: {
          scope: 'storage.drive.sync',
          code: 'DRIVE_RESYNC_RECONCILE_COMPLETE',
          queuedCount: queued.length,
          workKeys: queued,
        },
      })
    } catch (error) {
      appLogger.error('Drive reconciliation pass failed', {
        attrs: {
          scope: 'storage.drive.sync',
          code: 'DRIVE_RESYNC_RECONCILE_FAILED',
          error: String(error),
        },
      })
    } finally {
      running = false
      if (wakeAgain) {
        wakeAgain = false
        void reconcile()
      }
    }
  }
  const onOnline = () => {
    void reconcile()
  }
  window.addEventListener('online', onOnline)
  const timer = window.setInterval(onOnline, DRIVE_RECONCILE_INTERVAL_MS)
  // A restored credential is a reason to try an existing error immediately.
  void reconcile(options.retryErrors)
  return () => {
    stopped = true
    window.clearInterval(timer)
    window.removeEventListener('online', onOnline)
  }
}
