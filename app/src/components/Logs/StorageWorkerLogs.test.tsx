// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StorageWorkerLogs from './StorageWorkerLogs'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  status: vi.fn(),
}))
vi.mock('../../storage/workerDiagnostics', () => ({
  listStorageWorkerSessions: mocks.list,
  readStorageWorkerLogs: mocks.read,
  getStorageWorkerStatus: mocks.status,
}))

/** A partial archive-only page explicitly identifies unavailable live evidence. */
function page(instanceId: string, message = 'Saved worker event') {
  return {
    instanceId,
    events: [
      {
        instanceId,
        sequence: 1,
        id: 'event',
        ts: '2026-10-31T00:00:00Z',
        level: 'info',
        message,
        attrs: {},
      },
    ],
    nextSequence: 1,
    latestSequence: 1,
    dropped: 0,
    hasMore: false,
    partial: true,
    sources: {
      memory: { state: 'unavailable', error: 'Worker response timed out' },
      opfs: { state: 'available', corruptChunks: 0 },
    },
  }
}
beforeEach(() => {
  mocks.list
    .mockReset()
    .mockResolvedValue({
      workers: [],
      persisted: [{ instanceId: 'old-one' }, { instanceId: 'old-two' }],
      discoveryComplete: false,
      errors: [],
    })
  mocks.read
    .mockReset()
    .mockImplementation(async ({ instanceId }) => page(instanceId))
  mocks.status.mockReset().mockRejectedValue(new Error('Worker gone'))
})
afterEach(cleanup)

it('shows persisted evidence and unknown live state without notebook storage', async () => {
  render(<StorageWorkerLogs />)
  expect(await screen.findByText('Saved worker event')).toBeTruthy()
  expect(screen.getByText(/worker state is unknown/)).toBeTruthy()
  expect(screen.getByText(/Partial evidence/)).toBeTruthy()
  expect(
    screen
      .getByRole('button', { name: 'Export loaded JSON' })
      .hasAttribute('disabled')
  ).toBe(false)
  fireEvent.change(screen.getByLabelText('Scope'), {
    target: { value: 'storage.trace' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
  await waitFor(() =>
    expect(mocks.read).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'storage.trace', afterSequence: 0 })
    )
  )
})

it('ignores late results from an old worker selection', async () => {
  let resolveFirst!: (value: unknown) => void
  mocks.read.mockImplementation(({ instanceId }) =>
    instanceId === 'old-one'
      ? new Promise((resolve) => {
          resolveFirst = resolve
        })
      : Promise.resolve(page(instanceId, 'Second worker'))
  )
  render(<StorageWorkerLogs />)
  await waitFor(() => expect(mocks.read).toHaveBeenCalled())
  fireEvent.change(screen.getByLabelText('Storage worker instance'), {
    target: { value: 'old-two' },
  })
  expect(await screen.findByText('Second worker')).toBeTruthy()
  await act(async () => resolveFirst(page('old-one', 'Stale result')))
  expect(screen.queryByText('Stale result')).toBeNull()
})

it('clears a recovered read error without hiding discovery failures', async () => {
  mocks.list.mockResolvedValue({
    workers: [],
    persisted: [{ instanceId: 'old-one' }],
    discoveryComplete: false,
    errors: ['Discovery incomplete'],
  })
  mocks.read.mockRejectedValueOnce(new Error('Transient read failure'))
  render(<StorageWorkerLogs />)
  expect(await screen.findByText(/Worker logs are unavailable/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
  expect(await screen.findByText('Saved worker event')).toBeTruthy()
  expect(screen.queryByText(/Worker logs are unavailable/)).toBeNull()
  expect(screen.getByText('Discovery incomplete')).toBeTruthy()
})
