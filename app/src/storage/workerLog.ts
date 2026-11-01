import type {
  LogEvent,
  LogLevel,
  LoggingRuntimeStore,
} from '../lib/logging/runtime'

export type WorkerLogIdentity = {
  instanceId: string
  releaseId?: string
  epoch: number
}
export type WorkerLogEvent = LogEvent &
  WorkerLogIdentity & { schemaVersion: 1; sequence: number }
export type WorkerLogQuery = {
  afterSequence?: number
  limit?: number
  maxBytes?: number
  minLevel?: LogLevel
  scope?: string
  requestId?: string
}
export type WorkerLogPage = {
  events: WorkerLogEvent[]
  nextSequence: number
  latestSequence: number
  dropped: number
  hasMore: boolean
}
const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}
// Only scalar diagnostic metadata is eligible for cross-context/disk delivery.
// Existing app log attrs sometimes contain full notebooks or credentials.
const allowed = new Set([
  'scope',
  'phase',
  'state',
  'operation',
  'stage',
  'method',
  'requestId',
  'elapsedMs',
  'database',
  'store',
  'errorName',
  'pendingRequests',
  'connectedClients',
  'phaseElapsedMs',
  'force',
  'restart',
])

/** Remove URLs and credential-like strings from bounded human-readable text. */
function cleanText(value: string): string {
  return value
    .slice(0, 4096)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /(?:access_token|refresh_token|password|secret|authorization)\s*[:=]\s*\S+/gi,
      '[redacted]'
    )
    .slice(0, 1024)
}

/** Normalize before retention/serialization. Arbitrary objects never enter the log. */
function sanitize(event: LogEvent): LogEvent {
  const attrs: Record<string, unknown> = {}
  for (const key of allowed) {
    const value = event.attrs?.[key]
    if (typeof value === 'string') attrs[key] = cleanText(value)
    else if (typeof value === 'number' && Number.isFinite(value))
      attrs[key] = value
    else if (typeof value === 'boolean') attrs[key] = value
  }
  return {
    id: event.id,
    ts: event.ts,
    level: event.level,
    message: cleanText(event.message),
    attrs,
  }
}

/** Encoded byte accounting is shared by memory, persistence and transport caps. */
export function workerLogBytes(event: WorkerLogEvent): number {
  return new TextEncoder().encode(JSON.stringify(event) + '\n').byteLength
}

/** Return an ordered, bounded page; cursors advance past filtered-out entries. */
export function pageWorkerLogs(
  events: WorkerLogEvent[],
  query: WorkerLogQuery = {},
  latestSequence = events.at(-1)?.sequence ?? 0,
  dropped = 0
): WorkerLogPage {
  const after =
    Number.isSafeInteger(query.afterSequence) && query.afterSequence! >= 0
      ? query.afterSequence!
      : 0
  const limit = Math.min(500, Math.max(1, Math.floor(query.limit || 200)))
  const maxBytes = Math.min(
    262144,
    Math.max(16384, Math.floor(query.maxBytes || 262144))
  )
  const output: WorkerLogEvent[] = []
  let bytes = 0
  let nextSequence = after
  let hasMore = false
  for (const event of events) {
    if (event.sequence <= after) continue
    if (
      (query.minLevel && levels[event.level] < levels[query.minLevel]) ||
      (query.scope && event.attrs?.scope !== query.scope) ||
      (query.requestId && event.attrs?.requestId !== query.requestId)
    ) {
      nextSequence = event.sequence
      continue
    }
    const size = workerLogBytes(event)
    if (output.length >= limit || bytes + size > maxBytes) {
      hasMore = true
      break
    }
    output.push(structuredClone(event))
    bytes += size
    nextSequence = event.sequence
  }
  return { events: output, nextSequence, latestSequence, dropped, hasMore }
}

/** Context-local worker collector. It never waits for a persistence consumer. */
export class WorkerLogBuffer {
  private events: WorkerLogEvent[] = []
  private sequence = 0
  private bytes = 0
  private dropped = 0
  private readonly unsubscribe: () => void
  constructor(
    runtime: LoggingRuntimeStore,
    readonly identity: WorkerLogIdentity,
    private readonly sink?: (event: WorkerLogEvent) => void
  ) {
    this.unsubscribe = runtime.observe((event) => {
      const entry: WorkerLogEvent = {
        ...sanitize(event),
        ...identity,
        schemaVersion: 1,
        sequence: ++this.sequence,
      }
      const size = workerLogBytes(entry)
      // Oversized entries must not prevent pagination from ever advancing.
      if (size > 16384) {
        this.dropped++
        return
      }
      this.events.push(entry)
      this.bytes += size
      while (this.events.length > 500 || this.bytes > 1048576) {
        this.bytes -= workerLogBytes(this.events.shift()!)
        this.dropped++
      }
      try {
        this.sink?.(structuredClone(entry))
      } catch {
        /* Optional sink. */
      }
    })
  }
  read(query: WorkerLogQuery = {}): WorkerLogPage {
    return pageWorkerLogs(this.events, query, this.sequence, this.dropped)
  }
  close(): void {
    this.unsubscribe()
  }
}
