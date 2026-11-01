import { StorageWorkerControl, type WorkerStatus } from './storageWorkerControl'
import { type WorkerLogQuery, pageWorkerLogs } from './workerLog'
import { readWorkerArchive } from './workerLogArchive'

/** Clamp caller budgets so tools cannot leave channels/timers open indefinitely. */
function budget(value: number | undefined, fallback: number): number {
  return Number.isFinite(value)
    ? Math.min(10000, Math.max(100, value!))
    : fallback
}

/** Require a concrete worker, never silently target whichever one answers first. */
function requireInstance(instanceId: string): void {
  if (
    typeof instanceId !== 'string' ||
    !instanceId.trim() ||
    instanceId.length > 200
  )
    throw new Error(
      'A concrete worker instanceId from storageWorkers.list() is required'
    )
}

/** Discover cooperative Runme workers; absence is not proof that none exist. */
export function listStorageWorkers(
  options: { timeoutMs?: number } = {}
): Promise<{ workers: WorkerStatus[]; discoveryComplete: false }> {
  return new Promise((resolve, reject) => {
    const workers = new Map<string, WorkerStatus>()
    const control = new StorageWorkerControl((event) => {
      if (workers.size < 100 || workers.has(event.status.instanceId))
        workers.set(event.status.instanceId, event.status)
    })
    const timer = setTimeout(
      () => {
        control.close()
        resolve({ workers: [...workers.values()], discoveryComplete: false })
      },
      budget(options.timeoutMs, 1000)
    )
    try {
      control.discover()
    } catch (error) {
      clearTimeout(timer)
      control.close()
      reject(error)
    }
  })
}

/** Independent discovery works even before a worker attaches its notebook port. */
export function getStorageWorkerStatus(options: {
  instanceId: string
  timeoutMs?: number
}): Promise<WorkerStatus> {
  requireInstance(options.instanceId)
  return new Promise((resolve, reject) => {
    const control = new StorageWorkerControl((event) => {
      if (event.status.instanceId !== options.instanceId) return
      clearTimeout(timer)
      control.close()
      resolve(event.status)
    })
    const timer = setTimeout(
      () => {
        control.close()
        reject(
          new Error(
            'Worker status timed out; absence of a reply does not prove termination'
          )
        )
      },
      budget(options.timeoutMs, 2000)
    )
    try {
      control.discover()
    } catch (error) {
      clearTimeout(timer)
      control.close()
      reject(error)
    }
  })
}

/** Read memory over the early management channel, without notebook RPC or IDB. */
export async function readStorageWorkerMemory(
  options: WorkerLogQuery & { instanceId: string; timeoutMs?: number }
) {
  requireInstance(options.instanceId)
  const control = new StorageWorkerControl(() => {})
  try {
    return await control.readLogs(
      options.instanceId,
      options,
      budget(options.timeoutMs, 2000)
    )
  } finally {
    control.close()
  }
}

/** Combine independent evidence sources. Disk history remains available when the
 * old worker has exited; a source failure is distinct from an empty log.
 */
export async function readStorageWorkerLogs(
  options: WorkerLogQuery & { instanceId: string; timeoutMs?: number }
) {
  requireInstance(options.instanceId)
  const [memory, disk] = await Promise.allSettled([
    readStorageWorkerMemory(options),
    readWorkerArchive(
      (archive, check) => archive.read(options.instanceId, options, check),
      options.timeoutMs
    ),
  ])
  const live = memory.status === 'fulfilled' ? memory.value : undefined
  const persisted = disk.status === 'fulfilled' ? disk.value : undefined
  // A partially scanned disk page bounds how far the merged cursor can advance.
  // Newer memory events must not skip unread intermediate persisted history.
  const ceiling = persisted?.hasMore ? persisted.nextSequence : Infinity
  const entries = [
    ...(persisted?.events ?? []),
    ...(live?.events ?? []).filter((e) => e.sequence <= ceiling),
  ]
  const unique = [
    ...new Map(entries.map((e) => [e.sequence, e])).values(),
  ].sort((a, b) => a.sequence - b.sequence)
  const page = pageWorkerLogs(
    unique,
    options,
    Math.max(live?.latestSequence ?? 0, persisted?.latestSequence ?? 0),
    live?.dropped ?? 0
  )
  if (!page.hasMore && !page.events.length)
    page.nextSequence =
      persisted?.nextSequence ??
      live?.nextSequence ??
      options.afterSequence ??
      0
  return {
    ...page,
    instanceId: options.instanceId,
    hasMore: page.hasMore || !!persisted?.hasMore || !!live?.hasMore,
    partial:
      memory.status === 'rejected' ||
      disk.status === 'rejected' ||
      !!persisted?.corruptChunks,
    sources: {
      memory:
        memory.status === 'fulfilled'
          ? { state: 'available' as const, dropped: live!.dropped }
          : {
              state: 'unavailable' as const,
              error:
                memory.reason instanceof Error
                  ? memory.reason.message
                  : 'Worker logs unavailable',
            },
      opfs:
        disk.status === 'fulfilled'
          ? {
              state: 'available' as const,
              corruptChunks: persisted!.corruptChunks,
            }
          : {
              state: 'unavailable' as const,
              error:
                disk.reason instanceof Error
                  ? disk.reason.message
                  : 'Persisted logs unavailable',
            },
    },
  }
}

/** List persisted identities as well as cooperative live workers, without IDB. */
export async function listStorageWorkerSessions(
  options: { timeoutMs?: number } = {}
) {
  const [live, disk] = await Promise.allSettled([
    listStorageWorkers({
      timeoutMs: Math.min(options.timeoutMs ?? 1000, 1000),
    }),
    readWorkerArchive(
      (archive, check) => archive.list(check),
      options.timeoutMs
    ),
  ])
  return {
    workers: live.status === 'fulfilled' ? live.value.workers : [],
    persisted: disk.status === 'fulfilled' ? disk.value : [],
    discoveryComplete: false,
    errors: [
      live.status === 'rejected'
        ? 'Live worker discovery unavailable'
        : undefined,
      disk.status === 'rejected'
        ? 'Persisted worker discovery unavailable'
        : undefined,
    ].filter(Boolean),
  }
}

/** Ask one worker to drain/close. Only existing editor recovery retries pending
 * idempotent saves; this helper neither replays operations nor reloads tabs.
 * A stopped acknowledgment precedes replacement readiness, and is labeled so.
 */
export function restartStorageWorker(options: {
  instanceId: string
  mode?: 'graceful' | 'force'
  timeoutMs?: number
}): Promise<{
  instanceId: string
  requestId: string
  outcome: 'stopped' | 'unknown'
  replacementReady: false
  force: boolean
  lastPhase?: string
}> {
  requireInstance(options.instanceId)
  if (
    options.mode !== undefined &&
    options.mode !== 'graceful' &&
    options.mode !== 'force'
  )
    throw new Error('mode must be graceful or force')
  const requestId = crypto.randomUUID()
  const force = options.mode === 'force'
  return new Promise((resolve, reject) => {
    let lastPhase: string | undefined
    const finish = (outcome: 'stopped' | 'unknown') => {
      clearTimeout(timer)
      control.close()
      resolve({
        instanceId: options.instanceId,
        requestId,
        outcome,
        replacementReady: false,
        force,
        lastPhase,
      })
    }
    const control = new StorageWorkerControl((event) => {
      if (event.status.instanceId !== options.instanceId) return
      lastPhase = event.status.phase
      if (event.type === 'stopped' && event.requestId === requestId)
        finish('stopped')
    })
    const timer = setTimeout(
      () => finish('unknown'),
      budget(options.timeoutMs, 10000)
    )
    try {
      control.stop(options.instanceId, { force, restart: true, requestId })
    } catch (error) {
      clearTimeout(timer)
      control.close()
      reject(error)
    }
  })
}

/** Browser/AppKernel API shared by UI and automation. No storage is opened here. */
export const storageWorkersApi = {
  list: listStorageWorkers,
  status: getStorageWorkerStatus,
  readLogs: readStorageWorkerLogs,
  listSessions: listStorageWorkerSessions,
  restart: restartStorageWorker,
  help: () =>
    'storageWorkers.list({timeoutMs?}); status({instanceId, timeoutMs?}); readLogs({instanceId, afterSequence?, limit?, minLevel?, timeoutMs?}); restart({instanceId, mode?: "graceful" | "force", timeoutMs?}). Restart is cooperative; force skips draining and may leave writes uncertain. A stopped result does not prove replacement readiness. No tab is reloaded.',
}

/** Read-only namespace used by the Logs UI and direct WebMCP tools. */
export const workerLogsApi = {
  listWorkerSessions: listStorageWorkerSessions,
  getWorkerStatus: getStorageWorkerStatus,
  readWorkerLogs: readStorageWorkerLogs,
}
