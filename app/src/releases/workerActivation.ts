import { StorageWorkerControl } from '../storage/storageWorkerControl'
import { type Active, OWNER_LOCK, releasePrefix } from './control'
import { selectOwnerTarget } from './releasePreferences'

/** Ask responding owners to drain. A free lifetime lock, never a timeout or
 * missing reply, proves it is safe to construct the replacement's stores.
 */
export async function stopStorageOwners(target: Active): Promise<void> {
  let targetReady = false
  const stopped = new Set<string>()
  const management = new StorageWorkerControl((event) => {
    if (event.type !== 'status' || stopped.has(event.status.instanceId)) return
    if (
      event.status.releaseId === target.manifest.releaseId &&
      event.status.epoch === target.epoch
    ) {
      targetReady = event.status.phase === 'ready'
      return
    }
    stopped.add(event.status.instanceId)
    management.stop(event.status.instanceId, { force: false, restart: false })
  })
  try {
    const deadline = Date.now() + 30000
    while (true) {
      management.discover()
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (targetReady) return
      if (
        await navigator.locks.request(
          OWNER_LOCK,
          { ifAvailable: true },
          (lock) => Boolean(lock)
        )
      )
        return
      if (Date.now() >= deadline)
        throw new Error(
          'Storage is still draining. Keep editors open and retry activation; ownership has not been forced.'
        )
    }
  } finally {
    management.close()
  }
}

/** A target reference prevents a stale tab from constructing an obsolete owner.
 * Keep the launcher port alive until navigation; readiness is a memory message.
 */
export async function activateWorker(active: Active): Promise<SharedWorker> {
  await selectOwnerTarget(active)
  await stopStorageOwners(active)
  return new Promise((resolve, reject) => {
    const worker = new SharedWorker(
      releasePrefix(active.manifest.releaseId) + active.manifest.owner.entry,
      {
        type: 'module',
        name: `runme-storage-owner-${active.manifest.releaseId}-${active.epoch}`,
      }
    )
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            'Storage startup is taking too long. Retry activation or choose a cached release.'
          )
        ),
      30000
    )
    function fail(error: Error) {
      clearTimeout(timer)
      worker.port.close()
      reject(error)
    }
    worker.onerror = () =>
      fail(
        new Error(
          'Storage module failed to load; choose a cached release or retry.'
        )
      )
    worker.port.onmessage = ({ data }) => {
      if (data?.type === 'release-owner-error')
        fail(new Error(String(data.error)))
      if (
        data?.type === 'release-owner-ready' &&
        data.releaseId === active.manifest.releaseId &&
        data.epoch === active.epoch
      ) {
        clearTimeout(timer)
        resolve(worker)
      }
    }
    worker.port.start()
  })
}
