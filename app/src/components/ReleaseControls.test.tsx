import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReleaseControls } from './ReleaseControls'
import type { Control, ReleaseProgress } from '../releases/control'
import type { OfflineDownloadStatus } from '../releases/runtime'

vi.mock('../lib/logging/runtime', () => ({ appLogger: { warn: vi.fn() } }))
afterEach(() => {
  delete window.runmeVersions
})

/** Assert commands at the launcher boundary, rather than mutating active state
 * in the view. A channel switch must never silently activate a downloaded build.
 */
function setup(
  initialProgress?: ReleaseProgress,
  initialOffline?: OfflineDownloadStatus
) {
  const id = `${'a'.repeat(40)}-${'b'.repeat(64)}`
  const state = {
    format: 1,
    selection: { kind: 'channel', name: 'stable' },
    tabs: {},
    active: { epoch: 1, manifest: { releaseId: id } },
    candidate: { releaseId: `${'c'.repeat(40)}-${'d'.repeat(64)}` },
  } as Control
  const api = {
    get: vi.fn(async () => state),
    check: vi.fn(async () => {}),
    upgrade: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    prune: vi.fn(async () => 0),
    status: () => 'Installed release available',
    progress: vi.fn(() => initialProgress),
    offline: vi.fn(() => initialOffline),
    retryOffline: vi.fn(async () => {}),
    pin: vi.fn(async () => {}),
  }
  window.runmeVersions = api
  render(<ReleaseControls />)
  return api
}
describe('Information release controls', () => {
  it('separates app readiness from offline fonts and offers retry without an upgrade', async () => {
    const api = setup(undefined, {
      phase: 'downloading',
      completed: 12,
      total: 283,
    })
    const bar = await screen.findByRole('progressbar', {
      name: 'Fonts cached for offline use',
    })
    expect(bar.getAttribute('value')).toBe('12')
    expect(bar.getAttribute('max')).toBe('283')
    api.offline.mockReturnValue({ phase: 'error', completed: 12, total: 283 })
    fireEvent(window, new Event('runme-release-change'))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Retry offline font download' })
    )
    await waitFor(() => expect(api.retryOffline).toHaveBeenCalledTimes(1))
    expect(api.upgrade).not.toHaveBeenCalled()
    api.offline.mockReturnValue({ phase: 'ready', completed: 283, total: 283 })
    fireEvent(window, new Event('runme-release-change'))
    expect(
      await screen.findByText(
        'All release files are verified and cached for offline use.'
      )
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'Retry offline font download' })
    ).toBeNull()
  })
  it('shows verified-file progress and clears it when the operation ends', async () => {
    const api = setup({ completed: 24, total: 511 })
    const bar = await screen.findByRole('progressbar', {
      name: 'Release files verified',
    })
    expect(bar.getAttribute('value')).toBe('24')
    expect(bar.getAttribute('max')).toBe('511')
    api.progress.mockReturnValue(undefined)
    fireEvent(window, new Event('runme-release-change'))
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull())
  })
  it('shows the channel and stages a selection without activating it', async () => {
    const api = setup()
    expect(await screen.findByText('stable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Follow latest' }))
    await waitFor(() =>
      expect(api.check).toHaveBeenCalledWith({
        kind: 'channel',
        name: 'latest',
      })
    )
    expect(api.upgrade).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Activate release and update this tab',
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Activate release and update this tab',
      })
    )
    await waitFor(() => expect(api.upgrade).toHaveBeenCalledTimes(1))
  })
  it('keeps update errors visible in Information and permits retry', async () => {
    const api = setup()
    api.check.mockRejectedValueOnce(
      new Error('Release manifest checksum mismatch')
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Check for updates' })
    )
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Release manifest checksum mismatch'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await waitFor(() => expect(api.check).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
