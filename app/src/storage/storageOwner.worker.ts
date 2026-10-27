import { appLogger } from '../lib/logging/runtime'
import { OWNER_LOCK, control, readControl } from '../releases/control'
import { retireUnreadableOwner } from './releaseOwnerFailure'
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

/** Delay the store graph until exclusive ownership. Revalidate after acquisition;
 * a canceled candidate must never initialize stores or migrate data.
 */
async function start(): Promise<void> {
  if (!navigator.locks)
    throw new Error('Web Locks are required for storage ownership')
  await navigator.locks.request(OWNER_LOCK, async () => {
    setPhase('reading-release-settings')
    if (releaseId) {
      const state = await readControl()
      const pending = state.transition
      if (
        !(
          state.active?.manifest.releaseId === releaseId &&
          state.active.epoch === epoch &&
          pending?.phase !== 'handoff'
        ) &&
        !(
          pending?.phase === 'handoff' &&
          pending.target.releaseId === releaseId &&
          pending.epoch === epoch
        )
      )
        throw new Error('Storage candidate is no longer selected')
    }
    setPhase('recording-startup')
    if (releaseId)
      await control((s) => {
        s.ownerStartup = { releaseId, epoch, phase: 'initializing' }
      })
    setPhase('importing-runtime')
    const { startStorageOwner } = await import('./storageOwnerRuntime')
    setPhase('initializing-storage')
    runtime = await startStorageOwner(
      releaseId ? { releaseId, epoch } : undefined
    )
    finishRuntime()
    if (stopping) await new Promise<never>(() => {})
    const activeRuntime = runtime
    setPhase('publishing-ready')
    try {
      if (releaseId)
        await control((state) => {
          const pending = state.transition
          if (
            pending?.phase === 'handoff' &&
            pending.target.releaseId === releaseId &&
            pending.epoch === epoch
          ) {
            state.completedTransition = pending
            state.ownerStartup = { releaseId, epoch, phase: 'ready' }
            state.previous = state.active
            state.active = { manifest: pending.target, epoch }
            delete state.transition
            delete state.ownerError
          } else if (
            state.active?.epoch !== epoch ||
            state.active.manifest.releaseId !== releaseId
          )
            throw new Error('Storage admission changed during startup')
          delete state.emergencyRestart
          state.ownerStartup = { releaseId, epoch, phase: 'ready' }
        })
    } catch (error) {
      // If startup lost admission, finish maintenance before releasing ownership.
      await activeRuntime.drain()
      activeRuntime.close()
      throw error
    }
    setPhase('ready')
    attach = activeRuntime.attach
    for (const port of ports.splice(0)) attach(port)
    await new Promise<void>((resolve) => {
      let checking = false
      const timer = setInterval(async () => {
        if (!releaseId || checking) return
        checking = true
        try {
          const state = await readControl()
          if (
            state.transition?.phase === 'handoff' ||
            state.active?.epoch !== epoch
          ) {
            await activeRuntime.drain()
            clearInterval(timer)
            activeRuntime.close()
            resolve()
          }
        } catch (error) {
          // A failed drain is not proof that in-flight effects stopped. Keep the
          // lock and retry reconciliation; never release it on a timeout/error.
          try {
            if (
              await retireUnreadableOwner(error, activeRuntime, () => {
                clearInterval(timer)
                resolve()
              })
            )
              return
            await control((s) => {
              s.ownerError = {
                transitionId: s.transition?.id,
                message: `Storage drain blocked: ${String(error)}`,
              }
            })
          } catch {
            // Error reporting uses the same failing database. Do not let that
            // turn each timer tick into an unhandled rejection or release a lock.
            appLogger.warn(
              'Storage owner cannot drain or record its failure; ownership retained',
              { attrs: { scope: 'storage.owner' } }
            )
          }
        } finally {
          checking = false
        }
      }, 500)
    })
  })
  scope.close()
}
void start().catch(async (error) => {
  finishRuntime()
  setPhase('failed')
  await control((state) => {
    if (
      releaseId &&
      state.transition?.target.releaseId !== releaseId &&
      state.active?.manifest.releaseId !== releaseId
    )
      return
    state.ownerError = {
      transitionId: state.transition?.id,
      message: String(error),
    }
  }).catch(() => {})
  for (const port of ports)
    port.postMessage({ type: 'release-owner-error', error: String(error) })
  scope.close()
})
