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

  it('infers service account auth when JSON contains service account credentials', () => {
    const manager = createManager()

    manager.setOAuthClientFromJson(
      JSON.stringify({
        type: 'service_account',
        client_email: 'runme-drive-test@example.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
        private_key_id: 'key-id',
        token_uri: 'https://oauth2.googleapis.com/token',
      })
    )

    expect(manager.getOAuthClient()).toMatchObject({
      clientId: '',
      authFlow: 'service_account',
      authUxMode: 'new_tab',
      serviceAccount: {
        clientEmail: 'runme-drive-test@example.iam.gserviceaccount.com',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
        privateKeyId: 'key-id',
        tokenUri: 'https://oauth2.googleapis.com/token',
      },
    })
  })

  it('does not restore service account mode without credentials from local storage', () => {
    const manager = createManager()

    manager.setOAuthClientFromJson(
      JSON.stringify({
        type: 'service_account',
        client_email: 'runme-drive-test@example.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
        private_key_id: 'key-id',
        token_uri: 'https://oauth2.googleapis.com/token',
      })
    )

    const stored = JSON.parse(
      window.localStorage.getItem(GOOGLE_CLIENT_STORAGE_KEY) ?? '{}'
    ) as Record<string, string | undefined>
    expect(JSON.stringify(stored)).not.toContain('PRIVATE KEY')
    expect(stored.oauthAuthFlow).toBeUndefined()

    const reloadedManager = createManager()
    expect(reloadedManager.getOAuthClient()).toMatchObject({
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
    expect(reloadedManager.getOAuthClient()).not.toHaveProperty(
      'serviceAccount'
    )
  })

  it('clears service account credentials when switching to an OAuth flow', () => {
    const manager = createManager()

    manager.setOAuthClientFromJson(
      JSON.stringify({
        type: 'service_account',
        client_email: 'runme-drive-test@example.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
      })
    )
    manager.setAuthFlow('implicit')

    expect(manager.getOAuthClient()).toMatchObject({
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
    expect(manager.getOAuthClient()).not.toHaveProperty('serviceAccount')
  })
})
