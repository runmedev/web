import { beforeEach, describe, expect, it } from 'vitest'

import {
  GOOGLE_CLIENT_STORAGE_KEY,
  GoogleClientManager,
} from './googleClientManager'

function createManager(): GoogleClientManager {
  ;(
    GoogleClientManager as unknown as {
      singleton: GoogleClientManager | null
    }
  ).singleton = null
  return GoogleClientManager.instance()
}

describe('GoogleClientManager', () => {
  beforeEach(() => {
    window.localStorage.clear()
    ;(
      GoogleClientManager as unknown as {
        singleton: GoogleClientManager | null
      }
    ).singleton = null
  })

  it('reuses the OAuth client ID for Drive Picker config', () => {
    const manager = createManager()

    manager.setOAuthClient({
      clientId: '554943104515-example.apps.googleusercontent.com',
      clientSecret: 'secret',
    })

    expect(manager.getOAuthClient()).toEqual({
      clientId: '554943104515-example.apps.googleusercontent.com',
      clientSecret: 'secret',
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
    expect(manager.getDrivePickerConfig()).toEqual({
      clientId: '554943104515-example.apps.googleusercontent.com',
      developerKey: '',
      appId: 'notavalidappid',
    })
  })

  it('updates picker-only config without changing the OAuth client config', () => {
    const manager = createManager()

    manager.setDrivePickerConfig({
      clientId: '554943104515-example.apps.googleusercontent.com',
      developerKey: 'developer-key',
      appId: 'custom-app-id',
    })

    expect(manager.getOAuthClient()).toEqual({
      clientId: '',
      clientSecret: undefined,
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
    expect(manager.getDrivePickerConfig()).toEqual({
      clientId: '554943104515-example.apps.googleusercontent.com',
      developerKey: 'developer-key',
      appId: 'custom-app-id',
    })

    const stored = JSON.parse(
      window.localStorage.getItem(GOOGLE_CLIENT_STORAGE_KEY) ?? '{}'
    ) as Record<string, string | undefined>
    expect(stored).toEqual({})
  })

  it('defaults new Drive auth sessions to opening in a new tab', () => {
    const manager = createManager()

    expect(manager.getOAuthClient()).toEqual({
      clientId: '',
      clientSecret: undefined,
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
  })
})
