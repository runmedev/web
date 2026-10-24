import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReleaseControls } from './ReleaseControls'
import type { Control } from '../releases/control'

vi.mock('../lib/logging/runtime', () => ({ appLogger: { warn: vi.fn() } }))
afterEach(() => {
  delete window.runmeVersions
})

/** Assert commands at the launcher boundary, rather than mutating active state
 * in the view. A channel switch must never silently activate a downloaded build.
 */
function setup() {
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
    pin: vi.fn(async () => {}),
  }
  window.runmeVersions = api
  render(<ReleaseControls />)
  return api
}
describe('Information release controls', () => {
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
            name: 'Upgrade all tabs',
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade all tabs' }))
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
