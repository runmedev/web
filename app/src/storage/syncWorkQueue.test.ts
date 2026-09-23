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
