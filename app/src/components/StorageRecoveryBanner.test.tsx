import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import StorageRecoveryBanner from './StorageRecoveryBanner'
import { storageRecovery } from '../storage/storageRecovery'
const capture = vi.hoisted(() =>
  vi.fn(() => [
    { uri: 'local://draft', name: 'draft.runme', content: '{"cells":[]}' },
  ])
)
vi.mock('../lib/storageRecoveryDrafts', () => ({
  readRecoveryDrafts: () => {
    throw new Error('Storage unavailable')
  },
  captureNotebookRecoveryDrafts: capture,
}))
afterEach(() => {
  cleanup()
  storageRecovery.set({ phase: 'healthy', message: '' })
})
it('shows a startup failure detected before mounting in both UI locations', () => {
  const restart = vi.fn()
  storageRecovery.registerRestart(restart)
  storageRecovery.report(
    new Error(
      'Storage worker version mismatch. Reload all Runme tabs to reconnect.'
    )
  )
  render(
    <>
      <StorageRecoveryBanner location="notebook" />
      <StorageRecoveryBanner location="storage-status" />
    </>
  )
  const buttons = screen.getAllByRole('button', { name: 'Restart storage' })
  expect(buttons).toHaveLength(2)
  fireEvent.click(buttons[1])
  expect(restart).toHaveBeenCalledOnce()
})
it('does not show a recovery control for healthy storage', () => {
  render(<StorageRecoveryBanner location="notebook" />)
  expect(screen.queryByRole('alert')).toBeNull()
})
it('keeps force restart available while graceful restart is waiting', () => {
  storageRecovery.set({ phase: 'preparing', message: 'Preserving edits' })
  render(<StorageRecoveryBanner location="notebook" />)
  expect(
    screen
      .getByRole('button', { name: 'Restarting storage…' })
      .hasAttribute('disabled')
  ).toBe(true)
  expect(
    screen
      .getByRole('button', { name: 'Force restart storage' })
      .hasAttribute('disabled')
  ).toBe(false)
})
it('offers retry with the reason when preservation or coordination fails', () => {
  storageRecovery.set({
    phase: 'blocked',
    message: 'Another Runme tab did not acknowledge recovery.',
  })
  render(<StorageRecoveryBanner location="storage-status" />)
  expect(screen.getByText(/did not acknowledge/)).toBeTruthy()
  expect(
    screen
      .getByRole('button', { name: 'Restart storage' })
      .hasAttribute('disabled')
  ).toBe(false)
})

it('offers current editor downloads while storage is unavailable and restart is busy', () => {
  storageRecovery.set({ phase: 'preparing', message: 'Waiting for worker' })
  const createURL = vi.fn(() => 'blob:recovery')
  vi.stubGlobal('URL', { createObjectURL: createURL, revokeObjectURL: vi.fn() })
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {})
  render(<StorageRecoveryBanner location="notebook" />)
  fireEvent.click(screen.getByRole('button', { name: 'Get recovery copies' }))
  expect(capture).toHaveBeenCalled()
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Download draft.runme current editor copy',
    })
  )
  expect(createURL).toHaveBeenCalledWith(expect.any(Blob))
  expect(click).toHaveBeenCalledOnce()
  expect(screen.getByText(/Storage restart keeps this page/)).toBeTruthy()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('allows diagnostics while restart is waiting and reports an unresponsive worker', async () => {
  storageRecovery.set({ phase: 'preparing', message: 'Waiting for tabs' })
  const dispose = storageRecovery.registerDiagnostics(async () => {
    throw new Error('No diagnostic reply')
  })
  render(<StorageRecoveryBanner location="notebook" />)
  fireEvent.click(screen.getByRole('button', { name: 'Check storage worker' }))
  expect(await screen.findByText('Error: No diagnostic reply')).toBeTruthy()
  dispose()
})
