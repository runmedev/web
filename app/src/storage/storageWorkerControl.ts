import type { StorageOwnerDiagnostics } from './storageOwnerDiagnostics'

export const STORAGE_WORKER_CONTROL = 'runme-storage-worker-control-v1'
export type WorkerStatus = {
  instanceId: string
  releaseId?: string
  epoch: number
  phase: string
  phaseElapsedMs: number
  uptimeMs: number
  diagnostics?: StorageOwnerDiagnostics
  releaseDatabase?: StorageOwnerDiagnostics['releaseDatabase']
  error?: string
}
export type WorkerControlEvent =
  | { type: 'status'; status: WorkerStatus }
  | { type: 'stopping' | 'stopped'; status: WorkerStatus; restart: boolean }
type WorkerCommand =
  | { type: 'discover' }
  | { type: 'stop'; instanceId: string; force: boolean; restart: boolean }

/** A memory-only management connection, independent of storage RPC and IndexedDB.
 * Discovery includes only responding Runme workers implementing this protocol.
 */
export class StorageWorkerControl {
  private readonly channel = new BroadcastChannel(STORAGE_WORKER_CONTROL)
  constructor(onEvent: (event: WorkerControlEvent) => void) {
    this.channel.onmessage = ({ data }) => {
      if (['status', 'stopping', 'stopped'].includes(data?.type) && data.status)
        onEvent(data as WorkerControlEvent)
    }
  }
  discover(): void {
    this.channel.postMessage({ type: 'discover' } satisfies WorkerCommand)
  }
  stop(
    instanceId: string,
    options: { force: boolean; restart: boolean }
  ): void {
    this.channel.postMessage({
      type: 'stop',
      instanceId,
      ...options,
    } satisfies WorkerCommand)
  }
  close(): void {
    this.channel.close()
  }
}

/** Install before lock acquisition/imports so a stalled startup remains visible.
 * Force-close is cooperative: the worker event loop must still process messages.
 * No tab acknowledgements are needed because this never reloads a page.
 */
export function installStorageWorkerControl(options: {
  status: () => WorkerStatus
  drain: () => Promise<void>
  close: () => void
  phase: (phase: string) => void
}): () => void {
  const channel = new BroadcastChannel(STORAGE_WORKER_CONTROL)
  let stopping = false
  let closed = false
  const publish = (type: 'stopping' | 'stopped', restart: boolean) =>
    channel.postMessage({
      type,
      status: options.status(),
      restart,
    } satisfies WorkerControlEvent)
  channel.onmessage = async ({ data }: MessageEvent<WorkerCommand>) => {
    if (data?.type === 'discover') {
      channel.postMessage({
        type: 'status',
        status: options.status(),
      } satisfies WorkerControlEvent)
      return
    }
    if (
      data?.type !== 'stop' ||
      data.instanceId !== options.status().instanceId ||
      closed
    )
      return
    // A force request can interrupt a graceful drain stuck in storage/network IO.
    if (stopping && !data.force) return
    stopping = true
    options.phase(data.force ? 'force-closing' : 'draining')
    publish('stopping', data.restart)
    try {
      if (!data.force) await options.drain()
      if (closed) return
      closed = true
      options.phase('closing')
      publish('stopped', data.restart)
      options.close()
    } catch (error) {
      stopping = false
      options.phase('drain-failed')
      channel.postMessage({
        type: 'status',
        status: { ...options.status(), error: String(error) },
      } satisfies WorkerControlEvent)
    }
  }
  return () => channel.close()
}
