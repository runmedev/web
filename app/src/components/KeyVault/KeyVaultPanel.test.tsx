import { webcrypto } from 'node:crypto'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import KeyVaultPanel from './KeyVaultPanel'
import { KeyVault, VAULT_STORAGE_KEY } from '../../lib/keyvault/store'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('creates a vault, masks and clears key inputs, and removes keys with confirmation', async () => {
  const vault = new KeyVault()
  render(<KeyVaultPanel vault={vault} />)
  fireEvent.change(screen.getByLabelText('Vault passphrase'), {
    target: { value: 'long test passphrase' },
  })
  fireEvent.change(screen.getByLabelText('Confirm passphrase'), {
    target: { value: 'long test passphrase' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create vault' }))
  await screen.findByRole('button', { name: 'Lock vault' })
  fireEvent.change(screen.getByLabelText('Key name'), {
    target: { value: 'openai-api' },
  })
  const input = screen.getByLabelText('Key value') as HTMLInputElement
  expect(input.type).toBe('password')
  fireEvent.change(input, { target: { value: 'test-secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
  await screen.findByText('Key saved.')
  expect(input.value).toBe('')
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain('test-secret')
  fireEvent.click(screen.getByRole('button', { name: 'Delete openai-api' }))
  expect(vault.getSnapshot().names).toContain('openai-api')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }))
  await screen.findByText('Key removed.')
  expect(vault.getSnapshot().names).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Lock vault' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Unlock vault' })).toBeTruthy()
  )
})
