import { SyncQueueMetrics } from './syncQueueMetrics'

/** A retry can request a delay without counting an unavailable dependency as failure. */
export class SyncDeferred extends Error {
  constructor(readonly delayMs: number) {
    super('Sync deferred')
  }
}

type Item = {
  group: string
  run: () => Promise<void>
  readyAt: number
  forced: boolean
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
  private readonly processing = new Map<
    string,
    { item: Item; waiters: Item['waiters'] }
  >()
  private readonly claimedGroups = new Set<string>()
  private readonly concurrency: number
  private scheduled = false
  private interactiveBurst = 0
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private readonly metrics = new SyncQueueMetrics()

  constructor(
    private readonly options: {
      /** Number of distinct files that can have in-flight work. */
      concurrency?: number
      /** Operations sharing this identity cannot overlap (e.g. source and export). */
      groupKey?: (key: string) => string
      minimumIntervalMs?: number
      retryBaseMs?: number
      retryMaxMs?: number
      onChange?: (key: string) => void
      shouldRetry?: (error: unknown) => boolean
    } = {}
  ) {
    this.concurrency = options.concurrency ?? 1
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1)
      throw new Error('Sync concurrency must be a positive integer')
  }

  /** Add background work without extending an existing deadline on each edit. */
  add(key: string, run: () => Promise<void>, delayMs = 0): void {
    if (!this.stopped) this.put(key, run, delayMs, false)
  }

  /** Scans discover missing work without dirtying or replacing an existing attempt. */
  ensure(key: string, run: () => Promise<void>, delayMs = 0): void {
    if (!this.stopped && !this.items.has(key))
      this.put(key, run, delayMs, false)
  }

  /** Explicit commands wait for one attempt; failures remain queued for recovery. */
  run(key: string, run: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Sync queue is closed'))
    return new Promise((resolve, reject) => {
      const active = this.processing.get(key)
      if (active && !active.item.dirty) {
        active.waiters.push({ resolve, reject })
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
    return item && !this.processing.has(key)
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
    // In-flight operations retain their claims until they actually settle. Closing
    // is not cancellation and must never permit another writer to overlap them.
    for (const key of this.items.keys())
      if (!this.processing.has(key)) this.items.delete(key)
    this.recordDepth()
  }

  /** Waiting keys exclude the active attempt, including while it awaits a lock. */
  private recordDepth(): void {
    this.metrics.depthChanged(this.items.size - this.processing.size)
  }

  /** Snapshot data belongs to the queue owner, so all tabs observe the same history. */
  getMetrics() {
    const now = Date.now()
    const waiting = [...this.items].filter(([key]) => !this.processing.has(key))
    const eligible = waiting.filter(([, item]) => item.readyAt <= now)
    return {
      ...this.metrics.snapshot(),
      depth: waiting.length,
      eligible: eligible.length,
      delayed: waiting.length - eligible.length,
      active: this.processing.size,
      concurrency: this.concurrency,
      blockedByFile: eligible.filter(([, item]) =>
        this.claimedGroups.has(item.group)
      ).length,
      activeForMs: [...this.processing.values()].reduce(
        (max, { item }) => Math.max(max, now - (item.lastStarted ?? now)),
        0
      ),
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
        group: this.options.groupKey?.(key) ?? key,
        run,
        readyAt: Math.max(Date.now() + delayMs, earliest),
        forced: force,
        dirty: true,
        failures: 0,
        waiters: [],
      }
      this.items.set(key, item)
    } else {
      // A scan/edit must not replace an explicit operation with a throttled one.
      if (force || !item.forced) item.run = run
      if (force) {
        // A requested follow-up becomes eligible now, not at the previous
        // attempt's original deadline. Repeated queued requests keep their age.
        item.readyAt =
          this.processing.has(key) && !item.forced
            ? Date.now()
            : Math.min(item.readyAt, Date.now())
      }
      item.forced ||= force
      item.dirty = true
    }
    this.schedule()
    return item
  }

  /** Schedule only claimable files. A busy file never occupies a worker slot or timer. */
  private schedule(): void {
    this.recordDepth()
    clearTimeout(this.timer)
    if (this.stopped || this.processing.size >= this.concurrency) return
    let next = Infinity
    for (const item of this.items.values()) {
      if (!this.claimedGroups.has(item.group))
        next = Math.min(next, item.readyAt)
    }
    if (!Number.isFinite(next)) return
    if (next <= Date.now()) {
      if (!this.scheduled) {
        this.scheduled = true
        queueMicrotask(() => {
          this.scheduled = false
          this.pump()
        })
      }
      return
    }
    this.timer = setTimeout(() => this.pump(), next - Date.now())
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
  }

  /** Claim synchronously, then run async I/O. JS tasks cannot interleave the claim step. */
  private pump(): void {
    if (this.stopped) return
    while (this.processing.size < this.concurrency) {
      const ready = [...this.items].filter(
        ([, item]) =>
          item.readyAt <= Date.now() && !this.claimedGroups.has(item.group)
      )
      // Interactive opens/syncs get the next free slot, with a bounded burst so
      // continuous foreground traffic cannot starve background reconciliation.
      const foreground = ready.find(([, item]) => item.forced)
      const background = ready.find(([, item]) => !item.forced)
      const entry =
        foreground && (!background || this.interactiveBurst < 3)
          ? foreground
          : background
      if (!entry) break
      this.interactiveBurst = entry[1].forced
        ? Math.min(3, this.interactiveBurst + 1)
        : 0
      const [key, item] = entry
      const waiters = item.waiters.splice(0)
      this.processing.set(key, { item, waiters })
      this.claimedGroups.add(item.group)
      void this.process(key, item, waiters)
    }
    this.schedule()
  }

  /** Completion acknowledges the claim in finally, on success and every failure path. */
  private async process(
    key: string,
    item: Item,
    waiters: Item['waiters']
  ): Promise<void> {
    item.dirty = false
    item.forced = false
    item.lastStarted = Date.now()
    this.metrics.dequeued(Math.max(0, item.lastStarted - item.readyAt))
    this.recordDepth()
    this.lastStarts.set(key, item.lastStarted)
    for (const [oldKey, started] of this.lastStarts) {
      if (started + (this.options.minimumIntervalMs ?? 120_000) < Date.now())
        this.lastStarts.delete(oldKey)
    }
    try {
      await item.run()
      item.failures = 0
      for (const waiter of waiters) waiter.resolve()
      if (!item.dirty || this.stopped) this.items.delete(key)
      else {
        if (!item.forced)
          item.readyAt =
            item.lastStarted + (this.options.minimumIntervalMs ?? 120_000)
        // A hot key goes behind other waiting files on its follow-up pass.
        this.items.delete(key)
        if (!this.stopped) this.items.set(key, item)
      }
    } catch (error) {
      for (const waiter of waiters) waiter.reject(error)
      if (this.stopped || this.options.shouldRetry?.(error) === false) {
        // The durable diagnostic remains visible; explicit sync can try again.
        for (const waiter of item.waiters) waiter.reject(error)
        item.waiters = []
        this.items.delete(key)
        return
      }
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
      this.processing.delete(key)
      this.claimedGroups.delete(item.group)
      // Notify only after releasing the claim. Observer failures cannot strand
      // capacity or produce an unhandled rejection from a background attempt.
      try {
        this.options.onChange?.(key)
      } catch {
        /* Diagnostics cannot stop queue progress. */
      } finally {
        this.schedule()
      }
    }
  }
}
