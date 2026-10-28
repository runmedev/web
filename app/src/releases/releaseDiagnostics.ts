/** Value-free, realm-local traces. Reading these never touches browser storage. */
export type ReleaseDatabaseTrace = {
  id: number
  mode: 'readonly' | 'readwrite'
  context: 'window' | 'worker'
  visibility: string
  elapsedMs: number
  startedAt: string
  phase: string
  phaseElapsedMs: number
  databaseVersion?: number
  chunksRead?: number
  chunksTotal?: number
  outcome?: 'complete' | 'failed'
  events: { phase: string; elapsedMs: number }[]
}
let sequence = 0
const active = new Map<number, ReturnType<typeof createReleaseTrace>>()
const recent: ReleaseDatabaseTrace[] = []
const failures: ReleaseDatabaseTrace[] = []

/** Capture the last callback reached, not an inferred browser transaction state. */
export function createReleaseTrace(write: boolean) {
  const started = performance.now()
  let changed = started
  const value: ReleaseDatabaseTrace = {
    id: ++sequence,
    mode: write ? 'readwrite' : 'readonly',
    context: typeof document === 'undefined' ? 'worker' : 'window',
    visibility:
      typeof document === 'undefined'
        ? 'unavailable'
        : document.visibilityState,
    elapsedMs: 0,
    startedAt: new Date().toISOString(),
    phase: 'open-requested',
    phaseElapsedMs: 0,
    events: [{ phase: 'open-requested', elapsedMs: 0 }],
  }
  const trace = {
    mark(phase: string) {
      changed = performance.now()
      value.phase = phase
      value.events.push({ phase, elapsedMs: Math.round(changed - started) })
      if (value.events.length > 12) value.events.shift()
    },
    details(
      details: Pick<
        ReleaseDatabaseTrace,
        'databaseVersion' | 'chunksRead' | 'chunksTotal'
      >
    ) {
      Object.assign(value, details)
    },
    snapshot(): ReleaseDatabaseTrace {
      return {
        ...value,
        elapsedMs: Math.round(performance.now() - started),
        phaseElapsedMs: Math.round(performance.now() - changed),
        events: value.events.map((event) => ({ ...event })),
      }
    },
    finish(outcome: 'complete' | 'failed') {
      value.outcome = outcome
      active.delete(value.id)
      recent.push(trace.snapshot())
      if (recent.length > 10) recent.shift()
      if (outcome === 'failed') {
        failures.push(trace.snapshot())
        if (failures.length > 10) failures.shift()
      }
    },
  }
  active.set(value.id, trace)
  return trace
}

/** Bounded snapshots include reads waiting before any IndexedDB callback fires. */
export function releaseDatabaseDiagnostics() {
  const pending: ReleaseDatabaseTrace[] = []
  for (const trace of active.values()) {
    pending.push(trace.snapshot())
    if (pending.length === 10) break
  }
  return {
    activeCount: active.size,
    active: pending,
    failures: failures.map((trace) => ({
      ...trace,
      events: trace.events.map((event) => ({ ...event })),
    })),
    recent: recent.map((trace) => ({
      ...trace,
      events: trace.events.map((event) => ({ ...event })),
    })),
  }
}
