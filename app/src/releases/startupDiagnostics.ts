import { type LogEvent, appLogger } from '../lib/logging/runtime'

/** Keep startup evidence readable before React, storage, or the app log viewer
 * can start. This bounded in-memory trace never writes to browser storage or
 * sends telemetry. Callers supply fixed stage names and release/worker metadata,
 * never document content, session URLs, tokens, or arbitrary error messages.
 */
export function startupDiagnostics() {
  const element = document.createElement('details')
  element.id = 'runme-startup-diagnostics'
  const summary = document.createElement('summary')
  summary.textContent = 'Startup diagnostics'
  const output = document.createElement('pre')
  output.id = 'runme-startup-diagnostics-log'
  output.style.cssText =
    'white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px'
  element.append(summary, output)
  const events: LogEvent[] = []

  /** Record only explicitly selected metadata; the DOM also exposes this trace
   * to browser-control tools that cannot inspect service-worker internals.
   */
  const record = (
    stage: string,
    state: 'started' | 'completed' | 'waiting' | 'failed' | 'info',
    attrs: Record<string, string | number | boolean | null> = {}
  ) => {
    const level =
      state === 'failed' ? 'error' : state === 'waiting' ? 'warn' : 'info'
    const event = appLogger[level](`Startup ${stage}: ${state}`, {
      attrs: { scope: 'releases.startup', stage, state, ...attrs },
    })
    events.push(event)
    if (events.length > 100) events.shift()
    output.textContent = JSON.stringify(events, null, 2)
    if (state === 'failed' || state === 'waiting') element.open = true
  }

  /** Report a stuck operation without timing it out: cancellation/ownership
   * semantics belong to the operation, not the diagnostics layer.
   */
  const begin = (stage: string) => {
    const started = performance.now()
    record(stage, 'started')
    const elapsed = () => Math.round(performance.now() - started)
    const timer = setTimeout(
      () => record(stage, 'waiting', { elapsedMs: elapsed() }),
      10000
    )
    let finished = false
    return (state: 'completed' | 'failed' = 'completed') => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      record(stage, state, { elapsedMs: elapsed() })
    }
  }

  /** Preserve the operation's result/error while recording its duration. */
  const step = async <T>(stage: string, run: () => Promise<T>): Promise<T> => {
    const finish = begin(stage)
    try {
      const result = await run()
      finish()
      return result
    } catch (error) {
      finish('failed')
      throw error
    }
  }

  return { element, record, begin, step }
}
