import { OWNER_LOCK, control, readControl } from '../releases/control'

const scope = globalThis as unknown as {
  onconnect: (event: MessageEvent) => void
  close(): void
}
const releaseId = import.meta.env.VITE_RUNME_RELEASE_ID as string | undefined
// CacheStorage responses retain their original URL, which can drop a query.
// The browser-assigned worker name is the authoritative instance identity.
const epoch = Number(
  (globalThis as unknown as { name: string }).name.split('-').pop()
)
const ports: MessagePort[] = []
let attach: ((port: MessagePort) => void) | undefined
scope.onconnect = (event) => {
  const port = event.ports[0]
  port.start()
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
    if (releaseId)
      await control((s) => {
        s.ownerStartup = { releaseId, epoch, phase: 'initializing' }
      })
    const { startStorageOwner } = await import('./storageOwnerRuntime')
    const runtime = await startStorageOwner(
      releaseId ? { releaseId, epoch } : undefined
    )
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
      await runtime.drain()
      runtime.close()
      throw error
    }
    attach = runtime.attach
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
            await runtime.drain()
            clearInterval(timer)
            runtime.close()
            resolve()
          }
        } catch (error) {
          // A failed drain is not proof that in-flight effects stopped. Keep the
          // lock and retry reconciliation; never release it on a timeout/error.
          await control((s) => {
            s.ownerError = {
              transitionId: s.transition?.id,
              message: `Storage drain blocked: ${String(error)}`,
            }
          })
        } finally {
          checking = false
        }
      }, 500)
    })
  })
  scope.close()
}
void start().catch(async (error) => {
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
