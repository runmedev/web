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

describe('reconciliation and terminal failures', () => {
  it('coalesces repeated discoveries without replacing an explicit queued operation', async () => {
    vi.useFakeTimers()
    const q = queue()
    let release!: () => void
    q.add(
      'blocker',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(0)
    const manual = vi.fn().mockResolvedValue(undefined)
    const background = vi.fn().mockResolvedValue(undefined)
    const done = q.run('source:local://file/1234', manual)
    for (let i = 0; i < 100; i++) {
      q.ensure('source:local://file/1234', background)
      q.add('source:local://file/1234', background)
    }
    expect(q.getMetrics().depth).toBe(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    await done
    expect(manual).toHaveBeenCalledOnce()
    expect(background).not.toHaveBeenCalled()
    expect(q.getMetrics().depth).toBe(0)
  })

  it('does not requeue an active key on scans, but retains one follow-up for actual edits', async () => {
    vi.useFakeTimers()
    const q = queue()
    let release!: () => void
    const first = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const latest = vi.fn().mockResolvedValue(undefined)
    q.add('source:local://file/1234', first)
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 100; i++) q.ensure('source:local://file/1234', first)
    release()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(first).toHaveBeenCalledOnce()
    expect(q.getMetrics().depth).toBe(0)

    q.add('source:local://file/1234', first)
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 100; i++) {
      q.add('source:local://file/1234', latest)
      q.ensure('source:local://file/1234', first)
    }
    release()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(latest).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledTimes(2)
    expect(q.getMetrics().depth).toBe(0)
  })

  it('puts a dirty follow-up behind already waiting keys', async () => {
    vi.useFakeTimers()
    const q = queue({ minimumIntervalMs: 0 })
    let release!: () => void
    const order: string[] = []
    q.add(
      'hot',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(0)
    q.add('cold', async () => {
      order.push('cold')
    })
    q.add('hot', async () => {
      order.push('hot')
    })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['cold', 'hot'])
  })

  it('removes terminal failures, rejects callers and permits explicit recovery', async () => {
    vi.useFakeTimers()
    const q = queue({ shouldRetry: () => false })
    const failed = vi.fn().mockRejectedValue(new Error('terminal'))
    const done = expect(q.run('a', failed)).rejects.toThrow('terminal')
    await vi.advanceTimersByTimeAsync(0)
    await done
    q.wake()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(failed).toHaveBeenCalledOnce()
    expect(q.getMetrics()).toMatchObject({ depth: 0, active: 0 })
    const fixed = vi.fn().mockResolvedValue(undefined)
    await q.run('a', fixed)
    expect(fixed).toHaveBeenCalledOnce()
  })
})

describe('parallel file claims', () => {
  it.each([10, 20])(
    'keeps at most %i distinct files in flight and refills free slots',
    async (concurrency) => {
      vi.useFakeTimers()
      const q = queue({ concurrency, minimumIntervalMs: 0 })
      const releases: Array<() => void> = []
      let active = 0,
        peak = 0,
        started = 0
      for (let i = 0; i < concurrency + 5; i++) {
        q.add(`file-${i}`, async () => {
          started++
          active++
          peak = Math.max(peak, active)
          await new Promise<void>((resolve) => releases.push(resolve))
          active--
        })
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(started).toBe(concurrency)
      expect(q.getMetrics()).toMatchObject({
        active: concurrency,
        depth: 5,
        concurrency,
      })
      releases.shift()!()
      await vi.advanceTimersByTimeAsync(0)
      expect(started).toBe(concurrency + 1)
      expect(active).toBe(concurrency)
      while (releases.length) {
        releases.splice(0).forEach((release) => release())
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(started).toBe(concurrency + 5)
      expect(peak).toBe(concurrency)
      expect(q.getMetrics()).toMatchObject({ active: 0, depth: 0 })
    }
  )

  it('holds one claim across source/export keys without consuming slots for blocked siblings', async () => {
    vi.useFakeTimers()
    const q = queue({
      concurrency: 10,
      groupKey: (key: string) => key.split(':')[1],
    })
    let release!: () => void
    const exportRun = vi.fn().mockResolvedValue(undefined)
    const otherRun = vi.fn().mockResolvedValue(undefined)
    q.add(
      'source:a',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 100; i++) q.ensure('source:a', async () => {})
    q.add('ipynb:a', exportRun)
    q.add('markdown:a', exportRun)
    q.add('source:b', otherRun)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(otherRun).toHaveBeenCalledOnce()
    expect(exportRun).not.toHaveBeenCalled()
    expect(q.getMetrics()).toMatchObject({
      active: 1,
      depth: 2,
      blockedByFile: 2,
      activeForMs: 25_000,
    })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(exportRun).toHaveBeenCalledTimes(2)
    expect(q.getMetrics()).toMatchObject({ depth: 0, active: 0 })
  })

  it('retains an edit during processing and lets explicit sync wait for that follow-up', async () => {
    vi.useFakeTimers()
    const q = queue({ concurrency: 10 })
    let release!: () => void
    const active = q.run(
      'a',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100_000)
    const latest = vi.fn().mockResolvedValue(undefined)
    for (let i = 0; i < 100; i++) q.add('a', latest)
    let finished = false
    const followup = q.run('a', latest).then(() => {
      finished = true
    })
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1_500)
    release()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([active, followup])
    expect(latest).toHaveBeenCalledOnce()
    expect(q.getMetrics().waitHistogram.map((bucket) => bucket.count)).toEqual([
      1, 0, 1, 0, 0, 0, 0,
    ])
  })

  it('releases failed claims while retries back off and rejects terminal follow-up waiters', async () => {
    vi.useFakeTimers()
    const q = queue({
      concurrency: 2,
      groupKey: (key: string) => key.split(':')[1],
      shouldRetry: (e: unknown) => String(e) !== 'Error: terminal',
    })
    let fail!: (error: Error) => void
    q.add(
      'source:a',
      () =>
        new Promise<void>((_, reject) => {
          fail = reject
        })
    )
    await vi.advanceTimersByTimeAsync(0)
    q.add('source:a', async () => {})
    const followup = expect(q.run('source:a', async () => {})).rejects.toThrow(
      'terminal'
    )
    const sibling = vi.fn().mockResolvedValue(undefined)
    q.add('ipynb:a', sibling)
    fail(new Error('terminal'))
    await vi.advanceTimersByTimeAsync(0)
    await followup
    expect(sibling).toHaveBeenCalledOnce()
    expect(q.getMetrics()).toMatchObject({ active: 0, depth: 0 })
    q.add('source:b', async () => {
      throw new Error('offline')
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(q.getMetrics()).toMatchObject({ active: 0, delayed: 1 })
    const independent = vi.fn().mockResolvedValue(undefined)
    q.add('source:c', independent)
    await vi.advanceTimersByTimeAsync(0)
    expect(independent).toHaveBeenCalledOnce()
  })

  it('prioritizes explicit opens while admitting background work after three interactive jobs', async () => {
    vi.useFakeTimers()
    const q = queue({ concurrency: 1 })
    let release!: () => void
    q.add(
      'block',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(0)
    const order: string[] = []
    q.add('background', async () => {
      order.push('background')
    })
    const commands = Array.from({ length: 4 }, (_, i) =>
      q.run(`open-${i}`, async () => {
        order.push(`open-${i}`)
      })
    )
    release()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all(commands)
    expect(order).toEqual([
      'open-0',
      'open-1',
      'open-2',
      'background',
      'open-3',
    ])
  })

  it('does not abandon in-flight claims or start queued work on shutdown', async () => {
    vi.useFakeTimers()
    const q = queue({ concurrency: 2 })
    const releases: Array<() => void> = []
    const active = ['a', 'b'].map((key) =>
      q.run(key, () => new Promise<void>((r) => releases.push(r)))
    )
    await vi.advanceTimersByTimeAsync(0)
    const skipped = vi.fn()
    const pending = expect(q.run('c', skipped)).rejects.toThrow('closed')
    q.add('a', skipped)
    q.close()
    await pending
    expect(q.getMetrics()).toMatchObject({ active: 2, depth: 0 })
    releases.forEach((r) => r())
    await Promise.all(active)
    await vi.advanceTimersByTimeAsync(0)
    expect(skipped).not.toHaveBeenCalled()
    expect(q.getMetrics()).toMatchObject({ active: 0, depth: 0 })
  })

  it.each([0, -1, 1.5, Infinity, NaN])(
    'rejects invalid concurrency %s',
    (concurrency) => {
      expect(() => queue({ concurrency })).toThrow('positive integer')
    }
  )
})
