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

it('loads saved values into a masked editor and clears drafts on cancel or lock', async () => {
  const vault = new KeyVault()
  await vault.unlock('long test passphrase', true)
  await vault.saveKey('openai-api', 'saved-test-key')
  render(<KeyVaultPanel vault={vault} />)
  const valueInput = () =>
    screen.getByLabelText('Key value') as HTMLInputElement

  fireEvent.click(screen.getByRole('button', { name: 'Edit openai-api' }))
  expect(valueInput().value).toBe('saved-test-key')
  expect(valueInput().type).toBe('password')
  fireEvent.click(screen.getByRole('button', { name: 'Show key value' }))
  expect(valueInput().type).toBe('text')
  fireEvent.click(screen.getByRole('button', { name: 'Edit openai-api' }))
  expect(valueInput().value).toBe('saved-test-key')
  expect(valueInput().type).toBe('password')

  fireEvent.change(valueInput(), { target: { value: 'replacement-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
  await screen.findByText('Key saved.')
  expect(vault.requireValue('openai-api')).toBe('replacement-test-key')
  expect(valueInput().value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Edit openai-api' }))
  expect(valueInput().value).toBe('replacement-test-key')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }))
  expect(valueInput().value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Edit openai-api' }))
  fireEvent.click(screen.getByRole('button', { name: 'Lock vault' }))
  expect(screen.queryByLabelText('Key value')).toBeNull()
  expect(localStorage.getItem(VAULT_STORAGE_KEY)).not.toContain(
    'replacement-test-key'
  )
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
  fireEvent.click(screen.getByRole('button', { name: 'Show vault passphrase' }))
  expect(
    (screen.getByLabelText('Vault passphrase') as HTMLInputElement).type
  ).toBe('text')
  expect(
    (screen.getByLabelText('Confirm passphrase') as HTMLInputElement).type
  ).toBe('password')
  fireEvent.click(
    screen.getByRole('button', { name: 'Show confirm passphrase' })
  )
  expect(
    (screen.getByLabelText('Confirm passphrase') as HTMLInputElement).type
  ).toBe('text')
  expect(vault.getSnapshot().status).toBe('new')
  fireEvent.click(screen.getByRole('button', { name: 'Create vault' }))
  await screen.findByRole('button', { name: 'Lock vault' })
  fireEvent.change(screen.getByLabelText('Key name'), {
    target: { value: 'openai-api' },
  })
  const input = screen.getByLabelText('Key value') as HTMLInputElement
  expect(input.type).toBe('password')
  fireEvent.change(input, { target: { value: 'test-secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Show key value' }))
  expect(input.type).toBe('text')
  expect(input.value).toBe('test-secret')
  expect(vault.getSnapshot().names).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Hide key value' }))
  expect(input.type).toBe('password')
  fireEvent.click(screen.getByRole('button', { name: 'Show key value' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
  await screen.findByText('Key saved.')
  expect(input.value).toBe('')
  expect(input.type).toBe('password')
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
  expect(
    (screen.getByLabelText('Vault passphrase') as HTMLInputElement).type
  ).toBe('password')
})
