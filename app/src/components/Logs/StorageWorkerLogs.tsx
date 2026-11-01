import { useEffect, useRef, useState } from 'react'
import {
  getStorageWorkerStatus,
  listStorageWorkerSessions,
  readStorageWorkerLogs,
} from '../../storage/workerDiagnostics'
import type { WorkerLogEvent } from '../../storage/workerLog'
import type { WorkerStatus } from '../../storage/storageWorkerControl'
import type { LogLevel } from '../../lib/logging/runtime'

type Sessions = Awaited<ReturnType<typeof listStorageWorkerSessions>>
type Page = Awaited<ReturnType<typeof readStorageWorkerLogs>>
const fieldClass = 'rounded border border-white/20 bg-[#1b1d27] px-2 py-1'

/** Independent diagnostics view: no notebook context or storage-ready gate. Each
 * effect owns its request generation, preventing stale results after selection
 * changes. Follow waits for each bounded request before scheduling another.
 */
export default function StorageWorkerLogs() {
  const [sessions, setSessions] = useState<Sessions>()
  const [instanceId, setInstanceId] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [discovering, setDiscovering] = useState(false)
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [level, setLevel] = useState<LogLevel>('debug')
  const [scope, setScope] = useState('')
  const [requestId, setRequestId] = useState('')
  const [filters, setFilters] = useState({ scope: '', requestId: '' })
  const [follow, setFollow] = useState(false)
  const [cursor, setCursor] = useState(0)
  // Follow changes restart the effect, but must not rewind already-read pages.
  // Only changing the selection/filters or an explicit refresh resets progress.
  const progress = useRef(0)
  const [events, setEvents] = useState<WorkerLogEvent[]>([])
  const [page, setPage] = useState<Page>()
  const [status, setStatus] = useState<WorkerStatus>()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let active = true
    setDiscovering(true)
    void listStorageWorkerSessions()
      .then(
        (result) => {
          if (!active) return
          setSessions(result)
          setInstanceId(
            (current) =>
              current ||
              result.workers[0]?.instanceId ||
              result.persisted[0]?.instanceId ||
              ''
          )
          setError(result.errors.join('; '))
        },
        () => {
          if (active)
            setError(
              'Worker discovery is unavailable. Retry without clearing browser data.'
            )
        }
      )
      .finally(() => {
        if (active) setDiscovering(false)
      })
    return () => {
      active = false
    }
  }, [refresh])

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!instanceId) {
      setLoading(false)
      return
    }
    let afterSequence = progress.current
    /** Sequential follow keeps at most one page request active per view. */
    const load = async () => {
      setLoading(true)
      const [logs, snapshot] = await Promise.allSettled([
        readStorageWorkerLogs({
          instanceId,
          afterSequence,
          minLevel: level,
          ...filters,
        }),
        getStorageWorkerStatus({ instanceId, timeoutMs: 1000 }),
      ])
      if (!active) return
      setStatus(snapshot.status === 'fulfilled' ? snapshot.value : undefined)
      if (logs.status === 'fulfilled') {
        setReadError('')
        const next = logs.value
        setPage(next)
        setEvents((current) =>
          [
            ...new Map(
              [...current, ...next.events].map((e) => [e.sequence, e])
            ).values(),
          ]
            .sort((a, b) => a.sequence - b.sequence)
            .slice(-500)
        )
        afterSequence = next.nextSequence
        progress.current = next.nextSequence
      } else
        setReadError(
          'Worker logs are unavailable. Retry without clearing browser data.'
        )
      setLoading(false)
      if (follow) timer = setTimeout(() => void load(), 2000)
    }
    void load()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [instanceId, cursor, level, filters, follow, refresh])

  /** Export exactly the loaded evidence, including partial-source information. */
  const exportLogs = () => {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { instanceId, status, sources: page?.sources, events },
            null,
            2
          ),
        ],
        { type: 'application/json' }
      )
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `runme-worker-${instanceId}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const identities = [
    ...new Set([
      ...(sessions?.workers.map((w) => w.instanceId) ?? []),
      ...(sessions?.persisted.map((w) => w.instanceId) ?? []),
    ]),
  ]
  const reset = () => {
    progress.current = 0
    setCursor(0)
    setEvents([])
    setPage(undefined)
    setStatus(undefined)
    setReadError('')
  }

  return (
    <div
      id="storage-worker-logs"
      className="flex h-full min-h-0 flex-col bg-[#11121a] text-xs text-slate-200"
    >
      <div
        id="storage-worker-logs-controls"
        className="flex flex-wrap items-center gap-3 border-b border-white/10 p-3"
      >
        <label>
          Worker{' '}
          <select
            aria-label="Storage worker instance"
            className={fieldClass}
            value={instanceId}
            onChange={(e) => {
              reset()
              setInstanceId(e.target.value)
            }}
          >
            <option value="">Select a worker</option>
            {identities.map((id) => (
              <option key={id} value={id}>
                {id}
                {sessions?.workers.some((w) => w.instanceId === id)
                  ? ' (responded)'
                  : ' (persisted)'}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={fieldClass}
          disabled={discovering || loading}
          onClick={() => {
            reset()
            setRefresh((n) => n + 1)
          }}
        >
          {discovering ? 'Discovering…' : 'Refresh workers'}
        </button>
        <label>
          Minimum level{' '}
          <select
            className={fieldClass}
            value={level}
            onChange={(e) => {
              reset()
              setLevel(e.target.value as LogLevel)
            }}
          >
            {['debug', 'info', 'warn', 'error'].map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />{' '}
          Follow
        </label>
        <button
          type="button"
          className={fieldClass}
          disabled={!events.length}
          onClick={exportLogs}
        >
          Export loaded JSON
        </button>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            reset()
            setFilters({ scope, requestId })
          }}
        >
          <label>
            Scope{' '}
            <input
              className={fieldClass}
              maxLength={200}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
          </label>
          <label>
            Request ID{' '}
            <input
              className={fieldClass}
              maxLength={200}
              value={requestId}
              onChange={(e) => setRequestId(e.target.value)}
            />
          </label>
          <button type="submit" className={fieldClass}>
            Apply filters
          </button>
        </form>
      </div>
      <div
        id="storage-worker-logs-status"
        className="space-y-1 p-3"
        aria-live="polite"
      >
        {error && <p role="alert">{error}</p>}
        {readError && <p role="alert">{readError}</p>}
        {!identities.length && !discovering && (
          <p>
            No responding workers or persisted sessions found. This does not
            prove that no worker exists.
          </p>
        )}
        {instanceId && (
          <p>
            {status
              ? `Phase: ${status.phase} (${status.phaseElapsedMs} ms). Release: ${status.releaseId ?? 'development'}. Epoch: ${status.epoch}.`
              : 'Live status unavailable; worker state is unknown.'}
          </p>
        )}
        {status?.logPersistence && (
          <p>
            Persistence: {status.logPersistence.state}; pending{' '}
            {status.logPersistence.pendingBytes} bytes; dropped{' '}
            {status.logPersistence.dropped} events.
            {status.logPersistence.errorName &&
              ` ${status.logPersistence.errorName}`}
          </p>
        )}
        {page && (
          <p>
            Memory: {page.sources.memory.state}. OPFS: {page.sources.opfs.state}
            . {page.partial && 'Partial evidence.'} Memory evictions/drops:{' '}
            {page.dropped}.{' '}
            {page.sources.opfs.state === 'available' &&
              `Unreadable chunks: ${page.sources.opfs.corruptChunks}.`}
          </p>
        )}
        {page?.sources.memory.state === 'unavailable' && (
          <p>{page.sources.memory.error}</p>
        )}
        {page?.sources.opfs.state === 'unavailable' && (
          <p>{page.sources.opfs.error}</p>
        )}
        <p>
          {loading
            ? 'Reading worker logs…'
            : `${events.length} events loaded. At most 500 loaded events are retained in this view.`}
        </p>
      </div>
      <div
        id="storage-worker-logs-content"
        className="min-h-0 flex-1 overflow-auto p-3 font-mono"
      >
        <ul className="space-y-2">
          {events.map((e) => (
            <li
              key={`${e.instanceId}:${e.sequence}`}
              className="rounded border border-white/10 p-2"
            >
              <p>
                {e.ts} · #{e.sequence} · {e.level}
              </p>
              <p>{e.message}</p>
              <pre className="overflow-auto whitespace-pre-wrap">
                {JSON.stringify(e.attrs)}
              </pre>
            </li>
          ))}
        </ul>
        {!loading && page && !events.length && (
          <p>No available log entries match these filters.</p>
        )}
        <button
          type="button"
          className={`${fieldClass} mt-3`}
          disabled={!page?.hasMore || loading || follow}
          onClick={() => setCursor(page!.nextSequence)}
        >
          Load next page
        </button>
      </div>
    </div>
  )
}
