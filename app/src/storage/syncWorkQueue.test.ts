import { afterEach, describe, expect, it, vi } from 'vitest'

import { SyncDeferred, SyncWorkQueue } from './syncWorkQueue'

const queues: SyncWorkQueue[] = []
function queue(options = {}) {
  const q = new SyncWorkQueue(options)
  queues.push(q)
  return q
}
afterEach(() => {
  queues.splice(0).forEach((q) => q.close())
  vi.useRealTimers()
})

describe('delaying sync work queue', () => {
  it('coalesces queued edits without postponing the first scheduled save', async () => {
    vi.useFakeTimers()
    const q = queue(),
      run = vi.fn().mockResolvedValue(undefined)
    q.add('a', run, 20_000)
    await vi.advanceTimersByTimeAsync(10_000)
    q.add('a', run, 20_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('limits recurring saves and retains an edit arriving during processing', async () => {
    vi.useFakeTimers()
    const q = queue({ minimumIntervalMs: 120_000 })
    let release!: () => void
    const run = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue(undefined)
    q.add('a', run)
    await vi.advanceTimersByTimeAsync(0)
    q.add('a', run)
    release()
    await vi.advanceTimersByTimeAsync(119_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    q.add('a', run)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('backs off failures without starving ready files and caps the retry delay', async () => {
    vi.useFakeTimers()
    const q = queue({ retryBaseMs: 100, retryMaxMs: 400 })
    const fail = vi.fn().mockRejectedValue(new Error('offline')),
      healthy = vi.fn().mockResolvedValue(undefined)
    q.add('bad', fail)
    q.add('good', healthy)
    await vi.advanceTimersByTimeAsync(0)
    expect(healthy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(fail).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(fail).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(800)
    expect(fail).toHaveBeenCalledTimes(5)
  })

  it('keeps unavailable auth queued without a tight loop and wakes on recovery', async () => {
    vi.useFakeTimers()
    const q = queue(),
      run = vi
        .fn()
        .mockRejectedValueOnce(new SyncDeferred(120_000))
        .mockResolvedValue(undefined)
    q.add('a', run)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(1)
    q.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never overlaps explicit and background operations', async () => {
    const q = queue()
    let release!: () => void
    const first = q.run('a', () => new Promise<void>((r) => (release = r)))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const secondRun = vi.fn().mockResolvedValue(undefined),
      second = q.run('b', secondRun)
    expect(secondRun).not.toHaveBeenCalled()
    release()
    await first
    await second
    expect(secondRun).toHaveBeenCalledTimes(1)
  })
})

describe('owner queue diagnostics', () => {
  it('counts deduplicated waiting keys and measures only eligible wait', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T00:00:00Z'))
    const q = queue()
    let release!: () => void
    q.add(
      'active',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(0)
    q.add('delayed', async () => {}, 20_000)
    q.add('delayed', async () => {}, 20_000)
    expect(q.getMetrics()).toMatchObject({
      depth: 1,
      eligible: 0,
      delayed: 1,
      active: 1,
    })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(q.getMetrics()).toMatchObject({
      oldestEligibleWaitMs: 5_000,
      activeForMs: 25_000,
    })
    // Neither a repeated credential wake nor explicit sync resets time already waiting.
    q.wake()
    const done = q.run('delayed', async () => {})
    expect(q.getMetrics().oldestEligibleWaitMs).toBe(5_000)
    release()
    await vi.advanceTimersByTimeAsync(0)
    await done
    const metrics = q.getMetrics()
    expect(metrics).toMatchObject({ depth: 0, active: 0 })
    expect(metrics.waitHistogram.map((bucket) => bucket.count)).toEqual([
      1, 0, 0, 1, 0, 0, 0,
    ])
    expect(metrics.history.some((point) => point.depth === 1)).toBe(true)
  })

  it('counts retries separately without including their backoff', async () => {
    vi.useFakeTimers()
    const q = queue()
    const run = vi
      .fn()
      .mockRejectedValueOnce(new SyncDeferred(120_000))
      .mockResolvedValue(undefined)
    q.add('a', run)
    await vi.advanceTimersByTimeAsync(0)
    expect(q.getMetrics()).toMatchObject({ depth: 1, eligible: 0, delayed: 1 })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(q.getMetrics().waitHistogram.map((bucket) => bucket.count)).toEqual([
      2, 0, 0, 0, 0, 0, 0,
    ])
  })

  it('keeps bounded history while the view is closed and returns detached snapshots', async () => {
    vi.useFakeTimers()
    const q = queue()
    q.add('future', async () => {}, 10 * 60 * 60_000)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    const metrics = q.getMetrics()
    expect(metrics.history).toHaveLength(360)
    expect(metrics.history.every((point) => point.depth === 1)).toBe(true)
    metrics.history[0].depth = 900
    metrics.waitHistogram[0].count = 900
    expect(q.getMetrics().history[0].depth).toBe(1)
    expect(q.getMetrics().waitHistogram[0].count).toBe(0)
    q.close()
    expect(q.getMetrics().depth).toBe(0)
    expect(queue().getMetrics().waitHistogram[0].count).toBe(0)
  })
})
