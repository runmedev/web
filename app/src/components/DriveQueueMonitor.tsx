import { useEffect, useState } from 'react'

import type LocalNotebooks from '../storage/local'
import type { DriveQueueMetrics } from '../storage/syncQueueMetrics'

/** Keep duration labels comparable across the summary and histogram axes. */
function duration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`
  return `${(ms / 60_000).toFixed(1)} min`
}

/** Charts use owner snapshots, so closing this view does not lose queue history. */
export function DriveQueueCharts({ metrics }: { metrics: DriveQueueMetrics }) {
  const maxDepth = Math.max(1, ...metrics.history.map((point) => point.depth))
  const start = metrics.history[0]?.at ?? metrics.capturedAt
  const span = Math.max(10_000, metrics.capturedAt - start)
  const points = metrics.history.map(
    (point) =>
      `${44 + ((point.at - start) / span) * 480},${150 - (point.depth / maxDepth) * 120}`
  )
  const maxCount = Math.max(
    1,
    ...metrics.waitHistogram.map((bucket) => bucket.count)
  )
  const attempts = metrics.waitHistogram.reduce(
    (sum, bucket) => sum + bucket.count,
    0
  )
  const time = (value: number) => new Date(value).toLocaleTimeString()
  const labels = metrics.waitHistogram.map((bucket, index) => {
    const lower = index ? metrics.waitHistogram[index - 1].upperBoundMs! : 0
    return bucket.upperBoundMs === null
      ? `≥ ${duration(lower)}`
      : `${duration(lower)}–<${duration(bucket.upperBoundMs)}`
  })

  return (
    <section
      id="drive-queue-charts"
      aria-label="Sync queue monitoring"
      className="rounded-lg border border-nb-border bg-white p-4"
    >
      <h2 className="font-semibold text-nb-text">Sync queue</h2>
      <p className="mt-1 text-xs text-nb-text-muted">
        {metrics.depth} waiting · {metrics.eligible} eligible ·{' '}
        {metrics.delayed} delayed · {metrics.active} /{' '}
        {metrics.concurrency ?? 1} active · {metrics.blockedByFile ?? 0} waiting
        for the same file
      </p>
      <p className="mt-1 text-xs text-nb-text-muted">
        Oldest eligible wait: {duration(metrics.oldestEligibleWaitMs)}. Oldest
        active attempt: {duration(metrics.activeForMs)}.
      </p>
      <div id="drive-queue-plots" className="mt-3 grid gap-4 xl:grid-cols-2">
        <figure className="min-w-0">
          <figcaption className="text-sm font-medium">
            Queue depth over time
          </figcaption>
          <svg
            viewBox="0 0 560 190"
            role="img"
            aria-label="Waiting queue depth, peak per ten seconds"
            className="w-full"
          >
            <line x1="44" y1="30" x2="44" y2="150" stroke="currentColor" />
            <line x1="44" y1="150" x2="524" y2="150" stroke="currentColor" />
            <text x="36" y="34" textAnchor="end" fontSize="12">
              {maxDepth}
            </text>
            <text x="36" y="154" textAnchor="end" fontSize="12">
              0
            </text>
            <text x="44" y="178" fontSize="11">
              {time(start)}
            </text>
            <text x="524" y="178" textAnchor="end" fontSize="11">
              {time(metrics.capturedAt)}
            </text>
            <polyline
              points={points.join(' ')}
              fill="none"
              stroke="#0284c7"
              strokeWidth="2"
            />
            {metrics.history.map((point, index) => (
              <circle
                key={point.at}
                cx={points[index].split(',')[0]}
                cy={points[index].split(',')[1]}
                r="2"
                fill="#0284c7"
              >
                <title>
                  {time(point.at)}: {point.depth} waiting
                </title>
              </circle>
            ))}
          </svg>
          <p className="text-xs text-nb-text-muted">
            Peak waiting keys per 10 seconds, up to one hour. Includes delayed
            retries; excludes the active attempt.
          </p>
        </figure>
        <figure className="min-w-0">
          <figcaption className="text-sm font-medium">
            Eligible-to-dequeue wait
          </figcaption>
          <svg
            viewBox="0 0 560 230"
            role="img"
            aria-label={`Eligible-to-dequeue wait histogram, ${attempts} attempts`}
            className="w-full"
          >
            <line x1="44" y1="30" x2="44" y2="150" stroke="currentColor" />
            <line x1="44" y1="150" x2="524" y2="150" stroke="currentColor" />
            <text x="36" y="34" textAnchor="end" fontSize="12">
              {maxCount}
            </text>
            <text x="36" y="154" textAnchor="end" fontSize="12">
              0
            </text>
            {metrics.waitHistogram.map((bucket, index) => {
              const x = 52 + index * 67
              const height = (bucket.count / maxCount) * 120
              return (
                <g key={index}>
                  <rect
                    x={x}
                    y={150 - height}
                    width="48"
                    height={height}
                    fill="#0284c7"
                  >
                    <title>
                      {labels[index]}: {bucket.count} attempts
                    </title>
                  </rect>
                  <text
                    x={x + 24}
                    y={144 - height}
                    textAnchor="middle"
                    fontSize="11"
                  >
                    {bucket.count}
                  </text>
                  <text
                    transform={`translate(${x + 24},165) rotate(30)`}
                    textAnchor="start"
                    fontSize="10"
                  >
                    {labels[index]}
                  </text>
                </g>
              )
            })}
          </svg>
          <p className="text-xs text-nb-text-muted">
            {attempts
              ? `${attempts} dequeue attempts`
              : 'No dequeue attempts yet'}
            . Excludes scheduled debounce/backoff, processing time and locks
            acquired after dequeue. Retries count separately.
          </p>
        </figure>
      </div>
      <p className="mt-3 text-xs text-nb-text-muted">
        Last updated {new Date(metrics.capturedAt).toLocaleTimeString()}. Shared
        across tabs on this origin. History starts{' '}
        {new Date(metrics.startedAt).toLocaleString()} and resets when the
        storage worker restarts. Refreshes every 5 seconds.
      </p>
    </section>
  )
}

/** Poll one lightweight owner RPC at a time; stale/unmounted requests cannot update React. */
export function DriveQueueMonitor({
  store,
}: {
  store: Pick<LocalNotebooks, 'getDriveQueueMetrics'> | null
}) {
  const [metrics, setMetrics] = useState<DriveQueueMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    setMetrics(null)
    setError(null)
    if (!store) return
    const refresh = async () => {
      try {
        const snapshot = await store.getDriveQueueMetrics()
        if (!cancelled) {
          setMetrics(snapshot)
          setError(null)
        }
      } catch (error) {
        if (!cancelled) setError(String(error))
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 5_000)
      }
    }
    void refresh()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [store])
  if (error)
    return (
      <p role="status" className="text-sm text-red-700">
        Queue monitoring unavailable: {error}
      </p>
    )
  if (!metrics)
    return (
      <p role="status" className="text-sm text-nb-text-muted">
        Loading sync queue monitoring…
      </p>
    )
  return <DriveQueueCharts metrics={metrics} />
}
