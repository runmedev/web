import '@testing-library/jest-dom/vitest'
import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { SyncWorkQueue } from '../storage/syncWorkQueue'
import { DriveQueueCharts, DriveQueueMonitor } from './DriveQueueMonitor'

afterEach(() => vi.useRealTimers())

it('shows backlog separately from completed dequeue observations', () => {
  const queue = new SyncWorkQueue()
  queue.add('waiting', async () => {}, 60_000)
  try {
    render(<DriveQueueCharts metrics={queue.getMetrics()} />)
    expect(
      screen.getByText(
        '1 waiting · 0 eligible · 1 delayed · 0 / 1 active · 0 waiting for the same file'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', {
        name: 'Waiting queue depth, peak per ten seconds',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', {
        name: 'Eligible-to-dequeue wait histogram, 0 attempts',
      })
    ).toBeInTheDocument()
    expect(screen.getByText(/No dequeue attempts yet/)).toBeInTheDocument()
  } finally {
    queue.close()
  }
})

it('polls owner metrics without overlapping requests and stops on unmount', async () => {
  vi.useFakeTimers()
  const queue = new SyncWorkQueue()
  let resolve!: (value: ReturnType<SyncWorkQueue['getMetrics']>) => void
  const store = {
    getDriveQueueMetrics: vi.fn(
      () =>
        new Promise<ReturnType<SyncWorkQueue['getMetrics']>>((r) => {
          resolve = r
        })
    ),
  }
  const view = render(<DriveQueueMonitor store={store} />)
  await act(() => vi.advanceTimersByTimeAsync(15_000))
  expect(store.getDriveQueueMetrics).toHaveBeenCalledTimes(1)
  await act(async () => resolve(queue.getMetrics()))
  expect(screen.getByText('Sync queue')).toBeInTheDocument()
  await act(() => vi.advanceTimersByTimeAsync(5_000))
  expect(store.getDriveQueueMetrics).toHaveBeenCalledTimes(2)
  view.unmount()
  await act(async () => resolve(queue.getMetrics()))
  await act(() => vi.advanceTimersByTimeAsync(10_000))
  expect(store.getDriveQueueMetrics).toHaveBeenCalledTimes(2)
  queue.close()
})

it('reports unavailable diagnostics rather than displaying a healthy zero', async () => {
  const store = {
    getDriveQueueMetrics: vi
      .fn()
      .mockRejectedValue(new Error('Worker unavailable')),
  }
  render(<DriveQueueMonitor store={store} />)
  expect(
    await screen.findByText(
      'Queue monitoring unavailable: Error: Worker unavailable'
    )
  ).toBeInTheDocument()
})
