import type { createAgentsApi } from './runtime'

/** Explicit allowlist prevents sandbox code from installing credential callbacks. */
export function callAgentsBridge(
  api: ReturnType<typeof createAgentsApi>,
  method: string,
  args: unknown[]
): unknown {
  const id = String(args[0] ?? '')
  switch (method) {
    case 'agents.help':
      return api.help()
    case 'agents.monitor':
      return api.monitor(id, (args[1] ?? {}) as { pageSize?: number })
    case 'agents.get':
      return api.get(id)
    case 'agents.pause':
      return api.pause(id)
    case 'agents.resume':
      return api.resume(id)
    case 'agents.older':
      return api.older(id)
    case 'agents.newer':
      return api.newer(id)
    case 'agents.latest':
      return api.latest(id)
    default:
      throw new Error(`Unsupported agents sandbox method: ${method}`)
  }
}
