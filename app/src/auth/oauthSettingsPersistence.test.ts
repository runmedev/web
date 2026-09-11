// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise real manager storage failures, including retry and module recreation.
describe('OAuth settings persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })
  afterEach(() => vi.restoreAllMocks())

  it.each(['oidcConfig', 'googleClientConfig'])(
    'does not commit a failed %s write to memory and supports retry',
    async (storageKey) => {
      const { oidcConfigManager } = await import('./oidcConfig')
      const { googleClientManager } = await import('../lib/googleClientManager')
      oidcConfigManager.setConfig({
        discoveryUrl:
          'https://accounts.google.com/.well-known/openid-configuration',
        clientId: 'runme-client',
        scope: 'openid',
      })
      googleClientManager.setOAuthClient({
        clientId: 'old.apps.googleusercontent.com',
      })
      const read = () =>
        storageKey === 'oidcConfig'
          ? oidcConfigManager.getScope()
          : googleClientManager.getOAuthClient().clientId
      const save = () =>
        storageKey === 'oidcConfig'
          ? oidcConfigManager.setConfig(
              { scope: 'openid email' },
              { requirePersistence: true }
            )
          : googleClientManager.setOAuthClient(
              { clientId: 'new.apps.googleusercontent.com' },
              { requirePersistence: true }
            )
      const before = read()
      const storedBefore = localStorage.getItem(storageKey)
      const setItem = Storage.prototype.setItem
      const spy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(function (this: Storage, key, value) {
          if (key === storageKey)
            throw new DOMException('Quota exceeded', 'QuotaExceededError')
          setItem.call(this, key, value)
        })
      expect(save).toThrow(/Could not save/)
      expect(read()).toBe(before)
      expect(localStorage.getItem(storageKey)).toBe(storedBefore)
      // The small precedence flag would succeed despite the failed config write.
      localStorage.setItem('runme/app-config/prefer-local', 'false')
      spy.mockRestore()
      save()
      const expected = read()
      expect(expected).not.toBe(before)
      vi.resetModules()
      if (storageKey === 'oidcConfig') {
        expect(
          (await import('./oidcConfig')).oidcConfigManager.getScope()
        ).toBe(expected)
      } else {
        expect(
          (
            await import('../lib/googleClientManager')
          ).googleClientManager.getOAuthClient().clientId
        ).toBe(expected)
      }
    }
  )
})
