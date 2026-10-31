import { appLogger } from '../lib/logging/runtime'
import { OWNER_LOCK } from '../releases/control'
import { releaseDatabaseDiagnostics } from '../releases/releaseDiagnostics'
import { readOwnerTarget } from '../releases/releasePreferences'
import { installStorageWorkerControl } from './storageWorkerControl'

const scope = globalThis as unknown as {
  onconnect: (event: MessageEvent) => void
  close(): void
}
const releaseId = import.meta.env.VITE_RUNME_RELEASE_ID as string | undefined
// CacheStorage responses retain their original URL, which can drop a query.
// The browser-assigned worker name is the authoritative instance identity.
const epoch = releaseId
  ? Number((globalThis as unknown as { name: string }).name.split('-').pop())
  : 0
const instanceId = crypto.randomUUID()
const startedAt = Date.now()
let phase = 'waiting-for-lock'
let phaseStartedAt = startedAt
let runtime:
  | Awaited<
      ReturnType<(typeof import('./storageOwnerRuntime'))['startStorageOwner']>
    >
  | undefined
let stopping = false
/** Track the last reached boundary even while an awaited operation is stuck. */
function setPhase(next: string) {
  phase = next
  phaseStartedAt = Date.now()
  appLogger.info('Storage worker lifecycle', {
    attrs: { scope: 'storage.owner', instanceId, phase, releaseId, epoch },
  })
}
installStorageWorkerControl({
  status: () => ({
    instanceId,
    releaseId,
    epoch,
    phase,
    phaseElapsedMs: Date.now() - phaseStartedAt,
    uptimeMs: Date.now() - startedAt,
    diagnostics: runtime?.diagnostics(),
    releaseDatabase: releaseDatabaseDiagnostics(),
  }),
  phase: setPhase,
  drain: async () => {
    stopping = true
    // Before a runtime is available there are no admitted notebook requests.
    // Startup may nevertheless be opening stores: wait for it to settle before
    // graceful close. Force-close remains available on this independent channel.
    if (!runtime) await runtimeReady
    await runtime?.drain()
  },
  close: () => {
    stopping = true
    scope.close()
  },
})
let finishRuntime!: () => void
const runtimeReady = new Promise<void>((resolve) => {
  finishRuntime = resolve
})
const ports: MessagePort[] = []
let attach: ((port: MessagePort) => void) | undefined
scope.onconnect = (event) => {
  const port = event.ports[0]
  // Keep delivery paused until the host installs onmessage. Starting a port
  // while imports/lock acquisition are pending can discard the initial hello.
  if (attach) attach(port)
  else ports.push(port)
}

/** Reject obsolete worker names before constructing any store. The target is a
 * small Cache Storage reference written by explicit activation, never worker IO.
 */
async function assertSelected(): Promise<void> {
  if (!releaseId) return
  const selected = await readOwnerTarget()
  if (selected?.manifest.releaseId !== releaseId || selected.epoch !== epoch)
    throw new Error('Storage candidate is no longer selected')
}

/** Only the lifetime lock authorizes opening stores. Readiness and failures are
 * messages, not release-settings writes. Graceful stop closes RPC admission and
 * drains all effects before the worker and its lifetime lock are released.
 */
async function start(): Promise<void> {
  if (!navigator.locks)
    throw new Error('Web Locks are required for storage ownership')
  await navigator.locks.request(OWNER_LOCK, async () => {
    setPhase('checking-storage-target')
    await assertSelected()
    setPhase('importing-runtime')
    const { startStorageOwner } = await import('./storageOwnerRuntime')
    setPhase('initializing-storage')
    runtime = await startStorageOwner(
      releaseId ? { releaseId, epoch } : undefined
    )
    finishRuntime()
    try {
      // Activation may have changed while a store was initializing.
      await assertSelected()
      if (stopping) await new Promise<never>(() => {})
      setPhase('ready')
      attach = (port) => {
        if (stopping) {
          port.postMessage({
            type: 'release-owner-error',
            error: 'Storage is stopping; retry the connection.',
          })
          port.close()
          return
        }
        runtime!.attach(port)
        port.postMessage({ type: 'release-owner-ready', releaseId, epoch })
      }
      for (const port of ports.splice(0)) attach(port)
      await new Promise<never>(() => {})
    } catch (error) {
      await runtime.drain()
      runtime.close()
      throw error
    }
  })
}
void start().catch((error) => {
  finishRuntime()
  setPhase('failed')
  appLogger.error('Storage owner startup failed', {
    attrs: {
      scope: 'storage.owner',
      instanceId,
      releaseId,
      epoch,
      error: String(error),
    },
  })
  for (const port of ports)
    port.postMessage({ type: 'release-owner-error', error: String(error) })
  scope.close()
})
