/** Wire objects retain unknown fields so new API item types remain inspectable. */
export type AgentObject = Record<string, unknown>
export type AgentItem = AgentObject & {
  id: string | null
  type: string
  status?: string
  turn_id?: string
  role?: string
  phase?: string | null
  content?: AgentObject[]
}
export type AgentPage<T> = {
  data: T[]
  has_more: boolean
  last_id: string | null
}
export type AgentEvent = AgentObject & { type: string; event_id?: string }
export type AgentStream = {
  events: AsyncIterable<AgentEvent>
  close(): void
}
export interface AgentTransport {
  sendMessage(
    id: string,
    text: string,
    submissionId: string,
    signal: AbortSignal
  ): Promise<void>
  session(id: string, signal: AbortSignal): Promise<AgentObject>
  items(
    id: string,
    limit: number,
    after: string | undefined,
    signal: AbortSignal
  ): Promise<AgentPage<AgentItem>>
  turns(id: string, signal: AbortSignal): Promise<AgentPage<AgentObject>>
  stream(id: string, signal: AbortSignal): Promise<AgentStream>
}
export const AGENT_MONITOR_MIME = 'application/vnd.runme.agent-monitor+json'
export type AgentMonitorDescriptor = {
  version: 1
  id: string
  sessionId: string
  pageSize: number
}

/** Validate saved output before using it as a native widget descriptor. */
export function parseMonitorDescriptor(
  text: string
): AgentMonitorDescriptor | null {
  try {
    const value = JSON.parse(text)
    if (
      value?.version !== 1 ||
      typeof value.id !== 'string' ||
      !value.id ||
      typeof value.sessionId !== 'string' ||
      !value.sessionId.trim() ||
      !Number.isInteger(value.pageSize) ||
      value.pageSize < 1 ||
      value.pageSize > 100
    )
      return null
    return {
      version: 1,
      id: value.id,
      sessionId: value.sessionId,
      pageSize: value.pageSize,
    }
  } catch {
    return null
  }
}
