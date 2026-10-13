import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import StorageRecoveryBanner from './StorageRecoveryBanner'
import { storageRecovery } from '../storage/storageRecovery'
vi.mock('../lib/storageRecoveryDrafts', () => ({
  readRecoveryDrafts: () => [],
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
  const buttons = screen.getAllByRole('button', { name: 'Restart Runme' })
  expect(buttons).toHaveLength(2)
  fireEvent.click(buttons[1])
  expect(restart).toHaveBeenCalledOnce()
})
it('does not show a recovery control for healthy storage', () => {
  render(<StorageRecoveryBanner location="notebook" />)
  expect(screen.queryByRole('alert')).toBeNull()
})
it('disables duplicate requests while every tab prepares for reload', () => {
  storageRecovery.set({ phase: 'preparing', message: 'Preserving edits' })
  render(<StorageRecoveryBanner location="notebook" />)
  expect(
    screen
      .getByRole('button', { name: 'Preparing restart…' })
      .hasAttribute('disabled')
  ).toBe(true)
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
      .getByRole('button', { name: 'Restart Runme' })
      .hasAttribute('disabled')
  ).toBe(false)
})
