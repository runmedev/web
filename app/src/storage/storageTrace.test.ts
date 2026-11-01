import { afterEach, expect, it, vi } from 'vitest'

import { loggingRuntime } from '../lib/logging/runtime'
import { traceStorage } from './storageTrace'

afterEach(() => vi.useRealTimers())

it('reports a pending await without cancelling, retrying, or changing its result', async () => {
  vi.useFakeTimers()
  let complete!: (value: string) => void
  const run = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve
      })
  )
  const events: unknown[] = []
  const unsubscribe = loggingRuntime.observe((event) =>
    events.push(event.attrs)
  )
  try {
    const operation = traceStorage('test-pending-read', run, {
      database: 'test',
      store: 'folders',
    })
    await vi.advanceTimersByTimeAsync(5001)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'waiting',
          operation: 'test-pending-read',
        }),
      ])
    )
    expect(run).toHaveBeenCalledOnce()
    complete('original result')
    expect(await operation).toBe('original result')
    expect(events.at(-1)).toMatchObject({ state: 'completed' })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    unsubscribe()
  }
})

it('preserves the original error without logging its sensitive payload', async () => {
  const error = new Error('private notebook contents')
  await expect(
    traceStorage('test-error', () => Promise.reject(error))
  ).rejects.toBe(error)
  expect(loggingRuntime.list({ limit: 1 })[0]).toMatchObject({
    attrs: { operation: 'test-error', errorName: 'Error', state: 'failed' },
  })
  expect(JSON.stringify(loggingRuntime.list({ limit: 1 }))).not.toContain(
    error.message
  )
})
