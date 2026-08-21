// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { getBrowserAdapter } from './browserAdapter.client'

describe('BrowserAuthAdapter ephemeral service-account auth', () => {
  beforeEach(() => {
    window.localStorage.clear()
    getBrowserAdapter().logout()
  })

  it('installs a service-account ID token without persisting it', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    window.localStorage.setItem(
      'oidc-auth',
      JSON.stringify({ access_token: 'persisted-human-token' })
    )

    getBrowserAdapter().installEphemeralServiceAccountIdToken(
      'service-account-id-token',
      expiresAt
    )

    expect(getBrowserAdapter().simpleAuth).toMatchObject({
      accessToken: 'service-account-id-token',
      idToken: 'service-account-id-token',
      tokenType: 'Bearer',
    })
    expect(window.localStorage.getItem('oidc-auth')).toBeNull()
  })

  it('clears the effective service-account identity on logout', () => {
    getBrowserAdapter().installEphemeralServiceAccountIdToken(
      'service-account-id-token',
      new Date(Date.now() + 60_000).toISOString()
    )

    getBrowserAdapter().logout()

    expect(getBrowserAdapter().simpleAuth).toBeNull()
  })
})
