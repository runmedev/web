import { afterEach, expect, it, vi } from 'vitest'

import { startupDiagnostics } from './startupDiagnostics'

afterEach(() => vi.useRealTimers())

it('identifies an outstanding operation without cancelling it and records its eventual completion', async () => {
  vi.useFakeTimers()
  const trace = startupDiagnostics()
  let resolve!: (value: number) => void
  const result = trace.step(
    'initial-release-state',
    () =>
      new Promise<number>((r) => {
        resolve = r
      })
  )
  await vi.advanceTimersByTimeAsync(10000)
  expect(trace.element.open).toBe(true)
  expect(trace.element.textContent).toContain(
    'Startup initial-release-state: waiting'
  )
  resolve(7)
  await expect(result).resolves.toBe(7)
  expect(trace.element.textContent).toContain(
    'Startup initial-release-state: completed'
  )
  await vi.advanceTimersByTimeAsync(1) // Flush the details element's toggle event.
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves failures without recording arbitrary exception text or leaving timers alive', async () => {
  vi.useFakeTimers()
  const trace = startupDiagnostics()
  const error = new Error('private response body')
  await expect(
    trace.step('loader-connection', async () => {
      throw error
    })
  ).rejects.toBe(error)
  expect(trace.element.textContent).toContain(
    'Startup loader-connection: failed'
  )
  expect(trace.element.textContent).not.toContain(error.message)
  expect(trace.element.open).toBe(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds the trace and renders metadata as text instead of HTML', () => {
  const trace = startupDiagnostics()
  for (let i = 0; i < 120; i++) trace.record('metadata', 'info', { index: i })
  trace.record('metadata', 'info', { path: '<img src=x onerror=alert(1)>' })
  const events = JSON.parse(trace.element.querySelector('pre')!.textContent!)
  expect(events).toHaveLength(100)
  expect(events[0].attrs.index).toBe(21)
  expect(trace.element.querySelector('img')).toBeNull()
  expect(events[0].attrs.scope).toBe('releases.startup')
  expect(events[0].ts).toMatch(/^\d{4}-/)
})
