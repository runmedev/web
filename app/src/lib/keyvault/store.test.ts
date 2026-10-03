import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyVault, VAULT_STORAGE_KEY, resolveKeyReference } from './store'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => vi.unstubAllGlobals())
const password = 'a long test passphrase'

describe('encrypted key vault', () => {
  it('persists multiple named keys encrypted, unlocks after reload, and redacts references', async () => {
    const vault = new KeyVault()
    vault.refresh()
    expect(vault.getSnapshot().status).toBe('new')
    await vault.unlock(password, true)
    await vault.saveKey('openai-api', 'secret-alpha')
    await vault.saveKey('__proto__', 'secret-beta')
    expect(vault.getSnapshot().names).toEqual(['__proto__', 'openai-api'])
    const reference = vault.getKey('openai-api')
    expect(JSON.stringify(reference)).toBe('{"name":"openai-api"}')
    expect(resolveKeyReference(reference)).toBe('secret-alpha')
    const raw = localStorage.getItem(VAULT_STORAGE_KEY)!
    for (const value of [password, 'secret-alpha', 'secret-beta', 'openai-api'])
      expect(raw).not.toContain(value)
    vault.lock()
    expect(vault.getSnapshot().names).toEqual([])
    expect(() => resolveKeyReference(reference)).toThrow('Unlock')
    const reopened = new KeyVault()
    reopened.refresh()
    expect(reopened.getSnapshot().status).toBe('locked')
    await reopened.unlock(password)
    expect(resolveKeyReference(reopened.getKey('__proto__'))).toBe(
      'secret-beta'
    )
  })
  it('supports explicit rotation/rename/deletion without silently overwriting duplicate names', async () => {
    const vault = new KeyVault()
    await vault.unlock(password, true)
    await vault.saveKey('first', 'one')
    await vault.saveKey('second', 'two')
    const reference = vault.getKey('first')
    await expect(vault.saveKey('first', 'duplicate')).rejects.toThrow(
      'already exists'
    )
    await expect(vault.saveKey('second', 'duplicate', 'first')).rejects.toThrow(
      'already exists'
    )
    await vault.saveKey('first', 'rotated', 'first')
    expect(resolveKeyReference(reference)).toBe('rotated')
    await vault.saveKey('renamed', '', 'first')
    expect(() => resolveKeyReference(reference)).toThrow('missing')
    expect(resolveKeyReference(vault.getKey('renamed'))).toBe('rotated')
    await vault.deleteKey('renamed')
    expect(vault.getSnapshot().names).toEqual(['second'])
  })
  it('preserves ciphertext on incorrect passphrases and malformed data', async () => {
    const vault = new KeyVault()
    await vault.unlock(password, true)
    vault.lock()
    const raw = localStorage.getItem(VAULT_STORAGE_KEY)
    await expect(vault.unlock('incorrect')).rejects.toThrow('Unable to unlock')
    expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBe(raw)
    localStorage.setItem(VAULT_STORAGE_KEY, 'broken-json')
    await expect(vault.unlock(password)).rejects.toThrow('Unable to unlock')
    expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBe('broken-json')
  })
  it('rejects stale writes and locks a tab whose ciphertext changed', async () => {
    const first = new KeyVault(),
      second = new KeyVault()
    await first.unlock(password, true)
    await second.unlock(password)
    await first.saveKey('first', 'secret')
    await expect(second.saveKey('second', 'lost-update')).rejects.toThrow(
      'another tab'
    )
    expect(second.getSnapshot().status).toBe('locked')
    await second.unlock(password)
    expect(second.getSnapshot().names).toEqual(['first'])
  })
  it('does not finish unlocking after a lock and rejects forged references', async () => {
    const vault = new KeyVault()
    await vault.unlock(password, true)
    vault.lock()
    const pending = vault.unlock(password)
    vault.lock()
    await expect(pending).rejects.toThrow('locked')
    expect(vault.getSnapshot().status).toBe('locked')
    expect(() =>
      resolveKeyReference({ name: 'fake', toJSON: () => ({ name: 'fake' }) })
    ).toThrow('getKey')
  })
  it('does not publish unsaved mutations when browser storage is full', async () => {
    const vault = new KeyVault()
    await vault.unlock(password, true)
    await vault.saveKey('first', 'preserved')
    const mock = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('Quota')
      })
    await expect(vault.saveKey('second', 'unsaved')).rejects.toThrow(
      'Could not save'
    )
    expect(vault.getSnapshot().names).toEqual(['first'])
    mock.mockRestore()
  })
})
