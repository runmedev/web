import { AgentMonitor } from './monitor'
import { type AgentConnectionOptions, createAgentTransport } from './transport'
import {
  AGENT_MONITOR_MIME,
  type AgentMonitorDescriptor,
  type AgentTransport,
} from './types'

type Display = (mime: string, value: string) => void
let connection: AgentTransport | undefined
// This registry owns only this browser lifetime. Descriptors never carry auth or code.
const monitors = new Map<string, AgentMonitor>()
const autoConnect = new WeakSet<AgentMonitor>()
const mountedViews = new WeakMap<AgentMonitor, number>()

/** Resolve a saved descriptor without automatically connecting an opened notebook. */
export function resolveAgentMonitor(
  descriptor: AgentMonitorDescriptor
): AgentMonitor {
  const existing = monitors.get(descriptor.id)
  if (
    existing &&
    existing.descriptor.sessionId === descriptor.sessionId &&
    existing.descriptor.pageSize === descriptor.pageSize
  )
    return existing
  const monitor = new AgentMonitor(descriptor, () => {
    if (!connection)
      throw new Error(
        'Configure an authenticated connection with agents.configure({ baseUrl, getHeaders }) in AppKernel browser JS, then Connect.'
      )
    return connection
  })
  // Bound retained, detached monitor state; active widgets still own their controllers.
  if (monitors.size >= 100) {
    const oldest = [...monitors.entries()].find(
      ([, monitor]) => !mountedViews.get(monitor)
    )
    if (oldest) {
      oldest[1].pause()
      monitors.delete(oldest[0])
    }
  }
  monitors.set(descriptor.id, monitor)
  return monitor
}

/** Share a controller across output views and release it after the last view unmounts.
 * Deferring disposal one microtask tolerates React StrictMode's cleanup/remount probe.
 */
export function mountAgentMonitor(monitor: AgentMonitor): () => void {
  mountedViews.set(monitor, (mountedViews.get(monitor) ?? 0) + 1)
  if (
    autoConnect.has(monitor) &&
    !['live', 'connecting'].includes(monitor.getSnapshot().connection)
  )
    void monitor.connect()
  return () => {
    mountedViews.set(monitor, (mountedViews.get(monitor) ?? 1) - 1)
    queueMicrotask(() => {
      if (mountedViews.get(monitor)) return
      monitor.pause()
      autoConnect.delete(monitor)
    })
  }
}

/** Release process-local configuration and subscriptions (also used by tests). */
export function resetAgentMonitors(): void {
  monitors.forEach((monitor) => monitor.pause())
  monitors.clear()
  connection = undefined
}

/** The same commands back widget buttons, AppKernel cells and the sandbox bridge. */
export function createAgentsApi(display?: Display) {
  const requireMonitor = (id: string) => {
    const monitor = monitors.get(id)
    if (!monitor)
      throw new Error(
        'Monitor is not mounted in this browser session. Run its cell first.'
      )
    return monitor
  }
  return {
    configure: (options: AgentConnectionOptions) => {
      // Disconnect existing views before changing the authority serving their IDs.
      monitors.forEach((monitor) => monitor.pause())
      connection = createAgentTransport(options)
      return { configured: true }
    },
    monitor: (
      sessionId: string,
      options: { pageSize?: number } = {}
    ): AgentMonitorDescriptor => {
      if (!display)
        throw new Error(
          'agents.monitor must run in a notebook JS cell. Insert and execute a JS cell through notebooks.*.'
        )
      const pageSize = options.pageSize ?? 50
      if (typeof sessionId !== 'string' || !sessionId.trim())
        throw new Error('sessionId must be non-empty.')
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
        throw new Error('pageSize must be between 1 and 100.')
      const descriptor: AgentMonitorDescriptor = {
        version: 1,
        id: crypto.randomUUID(),
        sessionId: sessionId.trim(),
        pageSize,
      }
      const monitor = resolveAgentMonitor(descriptor)
      autoConnect.add(monitor)
      display(AGENT_MONITOR_MIME, JSON.stringify(descriptor))
      return descriptor
    },
    get: (id: string) => requireMonitor(id).getSnapshot(),
    pause: (id: string) => requireMonitor(id).pause(),
    resume: (id: string) => requireMonitor(id).connect(),
    older: (id: string) => requireMonitor(id).older(),
    newer: (id: string) => requireMonitor(id).newer(),
    latest: (id: string) => requireMonitor(id).latest(),
    help: () =>
      'agents.configure({ baseUrl, getHeaders? }) [browser JS only; memory-only auth]; agents.monitor(sessionId, { pageSize?: 1..100 }) [notebook JS cell]; agents.get(id); agents.pause(id); await agents.resume(id); await agents.older(id); await agents.newer(id); agents.latest(id). Pause stops observation, not the agent. Saved widgets require Connect.',
  }
}
