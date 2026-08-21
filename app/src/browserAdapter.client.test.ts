// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { mergeImpersonatedServiceAccountCredential } from './auth/impersonatedServiceAccountCredentialStore'
import {
  DEFAULT_APP_LOGIN_CONFIGURATION,
  saveAppLoginConfiguration,
} from './auth/appLoginConfiguration'
import { getBrowserAdapter } from './browserAdapter.client'

describe('BrowserAuthAdapter ephemeral service-account auth', () => {
  beforeEach(() => {
    window.localStorage.clear()
    getBrowserAdapter().logout()
  })

  it('installs a current-tab service-account ID token without human fallback', () => {
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

  it('hydrates a persisted short-lived service-account ID token after reload', () => {
    saveAppLoginConfiguration({
      ...DEFAULT_APP_LOGIN_CONFIGURATION,
      mode: 'service_account',
      humanAccount: 'jeremy@lewi.us',
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
    })
    mergeImpersonatedServiceAccountCredential({
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
      humanPrincipal: 'jeremy@lewi.us',
      authorizationLeaseExpiresAt: new Date(
        Date.now() + 86_400_000
      ).toISOString(),
      app: {
        idToken: 'persisted-service-account-id-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        audience: 'runme-client',
      },
    })

    expect(getBrowserAdapter().simpleAuth).toMatchObject({
      accessToken: 'persisted-service-account-id-token',
      idToken: 'persisted-service-account-id-token',
    })
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
