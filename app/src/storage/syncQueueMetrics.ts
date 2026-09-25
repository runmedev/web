/** Bounded, in-memory diagnostics owned by the sync worker, never notebook data. */
export const QUEUE_HISTORY_INTERVAL_MS = 10_000
export const QUEUE_HISTORY_BUCKETS = 360
const WAIT_UPPER_BOUNDS_MS = [100, 1_000, 5_000, 30_000, 120_000, 600_000]

export type QueueDepthPoint = { at: number; depth: number }
export type QueueWaitBucket = { upperBoundMs: number | null; count: number }
export type DriveQueueMetrics = {
  startedAt: number
  capturedAt: number
  depth: number
  eligible: number
  delayed: number
  concurrency?: number
  blockedByFile?: number
  active: number
  activeForMs: number
  oldestEligibleWaitMs: number
  history: QueueDepthPoint[]
  waitHistogram: QueueWaitBucket[]
}

/**
 * Keep peak depth in each 10-second bucket for up to an hour. Fill quiet periods
 * using the previous depth on the next event/read; no sampling timer is needed.
 * Histogram buckets count dequeue attempts for this worker's lifetime.
 */
export class SyncQueueMetrics {
  private readonly startedAt = Date.now()
  private depth = 0
  private history: QueueDepthPoint[] = []
  private readonly histogram: QueueWaitBucket[] = [
    ...WAIT_UPPER_BOUNDS_MS.map((upperBoundMs) => ({ upperBoundMs, count: 0 })),
    { upperBoundMs: null, count: 0 },
  ]

  /** Advance the history without allocating for every enqueue or reconciliation. */
  private advance(now: number): void {
    const bucket =
      Math.floor(now / QUEUE_HISTORY_INTERVAL_MS) * QUEUE_HISTORY_INTERVAL_MS
    const earliest =
      bucket - (QUEUE_HISTORY_BUCKETS - 1) * QUEUE_HISTORY_INTERVAL_MS
    this.history = this.history.filter((point) => point.at >= earliest)
    let next = this.history.length
      ? this.history[this.history.length - 1].at + QUEUE_HISTORY_INTERVAL_MS
      : Math.max(
          earliest,
          Math.floor(this.startedAt / QUEUE_HISTORY_INTERVAL_MS) *
            QUEUE_HISTORY_INTERVAL_MS
        )
    while (next <= bucket) {
      this.history.push({ at: next, depth: this.depth })
      next += QUEUE_HISTORY_INTERVAL_MS
    }
  }

  /** Repeated additions of the same key do not inflate depth. */
  depthChanged(depth: number): void {
    this.advance(Date.now())
    this.depth = depth
    const last = this.history[this.history.length - 1]
    if (last) last.depth = Math.max(last.depth, depth)
  }

  /** Delay is measured from eligibility, excluding scheduled debounce/backoff. */
  dequeued(waitMs: number): void {
    const bucket = this.histogram.find(
      (bucket) => bucket.upperBoundMs === null || waitMs < bucket.upperBoundMs
    )!
    bucket.count += 1
  }

  /** Detached snapshots can safely cross MessagePorts and be retained by React. */
  snapshot() {
    const capturedAt = Date.now()
    this.advance(capturedAt)
    return {
      startedAt: this.startedAt,
      capturedAt,
      history: this.history.map((point) => ({ ...point })),
      waitHistogram: this.histogram.map((bucket) => ({ ...bucket })),
    }
  }
}
