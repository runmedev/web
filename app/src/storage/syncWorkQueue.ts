import { SyncQueueMetrics } from './syncQueueMetrics'

/** A retry can request a delay without counting an unavailable dependency as failure. */
export class SyncDeferred extends Error {
  constructor(readonly delayMs: number) {
    super('Sync deferred')
  }
}

type Item = {
  run: () => Promise<void>
  readyAt: number
  dirty: boolean
  failures: number
  lastStarted?: number
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>
}

/**
 * A keyed delaying queue: queued additions coalesce, additions during processing
 * get another pass, and failures retry with controller-owned exponential backoff.
 * Only content/recovery state is durable. Restarting reconstructs work from it;
 * queue deadlines and failure counts intentionally start fresh.
 */
export class SyncWorkQueue {
  private readonly items = new Map<string, Item>()
  private readonly lastStarts = new Map<string, number>()
  private activeWaiters?: Item['waiters']
  private processing?: string
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private readonly metrics = new SyncQueueMetrics()

  constructor(
    private readonly options: {
      minimumIntervalMs?: number
      retryBaseMs?: number
      retryMaxMs?: number
      onChange?: (key: string) => void
    } = {}
  ) {}

  /** Add background work without extending an existing deadline on each edit. */
  add(key: string, run: () => Promise<void>, delayMs = 0): void {
    if (!this.stopped) this.put(key, run, delayMs, false)
  }

  /** Explicit commands wait for one attempt; failures remain queued for recovery. */
  run(key: string, run: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Sync queue is closed'))
    return new Promise((resolve, reject) => {
      if (this.processing === key && this.activeWaiters) {
        this.activeWaiters.push({ resolve, reject })
        return
      }
      const item = this.put(key, run, 0, true)
      item.waiters.push({ resolve, reject })
    })
  }

  /** Wake delayed items after a credential/connectivity change. */
  wake(): void {
    for (const item of this.items.values())
      item.readyAt = Math.min(item.readyAt, Date.now())
    this.schedule()
  }

  nextAttempt(key: string): string | undefined {
    const item = this.items.get(key)
    return item && key !== this.processing
      ? new Date(item.readyAt).toISOString()
      : undefined
  }

  /** Release timers; pending content is recovered by the next controller's scan. */
  close(): void {
    this.stopped = true
    clearTimeout(this.timer)
    for (const item of this.items.values()) {
      for (const waiter of item.waiters)
        waiter.reject(new Error('Sync queue is closed'))
      item.waiters = []
    }
    this.items.clear()
    this.recordDepth()
  }

  /** Waiting keys exclude the active attempt, including while it awaits a lock. */
  private recordDepth(): void {
    this.metrics.depthChanged(
      this.items.size -
        (this.processing && this.items.has(this.processing) ? 1 : 0)
    )
  }

  /** Snapshot data belongs to the queue owner, so all tabs observe the same history. */
  getMetrics() {
    const now = Date.now()
    const waiting = [...this.items].filter(([key]) => key !== this.processing)
    const eligible = waiting.filter(([, item]) => item.readyAt <= now)
    return {
      ...this.metrics.snapshot(),
      depth: waiting.length,
      eligible: eligible.length,
      delayed: waiting.length - eligible.length,
      active: this.processing ? 1 : 0,
      activeForMs: this.processing
        ? Math.max(
            0,
            now - (this.items.get(this.processing)?.lastStarted ?? now)
          )
        : 0,
      oldestEligibleWaitMs: eligible.reduce(
        (max, [, item]) => Math.max(max, now - item.readyAt),
        0
      ),
    }
  }

  private put(
    key: string,
    run: () => Promise<void>,
    delayMs: number,
    force: boolean
  ): Item {
    let item = this.items.get(key)
    if (!item) {
      const earliest = force
        ? 0
        : (this.lastStarts.get(key) ?? 0) +
          (this.options.minimumIntervalMs ?? 120_000)
      item = {
        run,
        readyAt: Math.max(Date.now() + delayMs, earliest),
        dirty: true,
        failures: 0,
        waiters: [],
      }
      this.items.set(key, item)
    } else {
      item.run = run
      item.dirty = true
      if (force) item.readyAt = Math.min(item.readyAt, Date.now())
    }
    this.schedule()
    return item
  }

  private schedule(): void {
    this.recordDepth()
    clearTimeout(this.timer)
    if (this.stopped || this.processing || !this.items.size) return
    let next = Infinity
    for (const item of this.items.values()) next = Math.min(next, item.readyAt)
    if (next <= Date.now()) {
      queueMicrotask(() => void this.process())
      return
    }
    this.timer = setTimeout(() => void this.process(), next - Date.now())
    // Node callers/tests should not stay alive just for background recovery.
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
  }

  private async process(): Promise<void> {
    if (this.stopped || this.processing) return
    const entry = [...this.items].find(([, item]) => item.readyAt <= Date.now())
    if (!entry) {
      this.schedule()
      return
    }
    const [key, item] = entry
    this.processing = key
    item.dirty = false
    item.lastStarted = Date.now()
    this.metrics.dequeued(Math.max(0, item.lastStarted - item.readyAt))
    this.recordDepth()
    this.lastStarts.set(key, item.lastStarted)
    for (const [oldKey, started] of this.lastStarts) {
      if (started + (this.options.minimumIntervalMs ?? 120_000) < Date.now())
        this.lastStarts.delete(oldKey)
    }
    const waiters = item.waiters.splice(0)
    this.activeWaiters = waiters
    try {
      await item.run()
      item.failures = 0
      for (const waiter of waiters) waiter.resolve()
      if (!item.dirty) this.items.delete(key)
      else
        item.readyAt =
          item.lastStarted + (this.options.minimumIntervalMs ?? 120_000)
    } catch (error) {
      for (const waiter of waiters) waiter.reject(error)
      const delay =
        error instanceof SyncDeferred
          ? error.delayMs
          : Math.min(
              this.options.retryMaxMs ?? 1_800_000,
              (this.options.retryBaseMs ?? 120_000) *
                2 ** Math.min(item.failures++, 14)
            )
      item.readyAt = Date.now() + delay
    } finally {
      this.activeWaiters = undefined
      this.processing = undefined
      this.options.onChange?.(key)
      this.schedule()
    }
  }
}
