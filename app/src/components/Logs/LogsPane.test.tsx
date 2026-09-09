// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LogEvent } from '../../lib/logging/runtime'
import LogsPane from './LogsPane'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  subscribe: vi.fn(),
  writeText: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('../../lib/logging/runtime', () => ({
  loggingRuntime: { list: mocks.list, subscribe: mocks.subscribe },
}))

vi.mock('../../lib/toast', () => ({ showToast: mocks.showToast }))

const entries: LogEvent[] = [
  {
    id: 'info-entry',
    ts: '2026-09-09T17:13:24.123Z',
    level: 'info',
    message: 'Drive resync reconciliation completed',
    attrs: { scope: 'storage.drive.sync', enqueuedCount: 3 },
  },
  {
    id: 'error-entry',
    ts: '2026-09-09T17:14:25.456Z',
    level: 'error',
    message: 'Sync failed: "retry"\nMore details',
    attrs: {
      scope: 'storage.drive.sync',
      code: 'DRIVE_SYNC_FAILED',
      details: { retryable: true, attempts: [1, 2], cause: null },
    },
  },
]

describe('LogsPane structured copying', () => {
  beforeEach(() => {
    mocks.list.mockReturnValue(entries)
    mocks.subscribe.mockReturnValue(() => {})
    mocks.writeText.mockReset().mockResolvedValue(undefined)
    mocks.showToast.mockReset()
    vi.stubGlobal('navigator', { clipboard: { writeText: mocks.writeText } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('copies only the chosen entry, including its full timestamp and nested attributes', async () => {
    render(<LogsPane />)
    const rows = screen.getAllByRole('listitem')
    expect(screen.getAllByRole('button', { name: 'Copy log entry as JSON' })).toHaveLength(2)

    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Copy log entry as JSON' }))

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith({
      message: 'Log entry copied as JSON', tone: 'success',
    }))
    expect(mocks.writeText).toHaveBeenCalledOnce()
    const copied = mocks.writeText.mock.calls[0][0]
    expect(JSON.parse(copied)).toEqual(entries[1])
    expect(copied).toContain('\n  "id": "error-entry"')
    expect(copied).not.toContain(entries[0].message)
  })

  it('copies an informational entry without optional attributes', async () => {
    const { attrs: _attrs, ...entry } = entries[0]
    mocks.list.mockReturnValue([entry])
    render(<LogsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy log entry as JSON' }))

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' })))
    expect(JSON.parse(mocks.writeText.mock.calls[0][0])).toEqual(entry)
  })

  it('reports success only after the clipboard write finishes', async () => {
    let resolveWrite!: () => void
    mocks.writeText.mockReturnValue(new Promise<void>(resolve => { resolveWrite = resolve }))
    render(<LogsPane />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy log entry as JSON' })[0])
    expect(mocks.showToast).not.toHaveBeenCalled()
    await act(async () => resolveWrite())
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }))
  })

  it.each(['denied', 'unavailable'])('reports a %s clipboard without claiming success', async mode => {
    if (mode === 'denied') {
      mocks.writeText.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'))
    } else {
      vi.stubGlobal('navigator', {})
    }
    render(<LogsPane />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy log entry as JSON' })[0])

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith({
      message: 'Failed to copy log entry to clipboard', tone: 'error',
    }))
    expect(mocks.showToast).toHaveBeenCalledOnce()
  })
})
