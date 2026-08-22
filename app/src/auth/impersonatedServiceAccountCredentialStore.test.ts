import { beforeEach, describe, expect, it } from 'vitest'

import {
  IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY,
  clearImpersonatedServiceAccountCredential,
  mergeImpersonatedServiceAccountCredential,
  readImpersonatedServiceAccountCredential,
  saveImpersonatedServiceAccountCredential,
} from './impersonatedServiceAccountCredentialStore'

const now = Date.parse('2026-08-21T20:00:00.000Z')

describe('impersonatedServiceAccountCredentialStore', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('persists short-lived service-account credentials without human tokens', () => {
    const createdAt = new Date().toISOString()
    const tokenExpiresAt = new Date(Date.now() + 3_600_000).toISOString()
    const leaseExpiresAt = new Date(Date.now() + 86_400_000).toISOString()
    saveImpersonatedServiceAccountCredential({
      version: 1,
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
      humanPrincipal: 'human@example.com',
      createdAt,
      authorizationLeaseExpiresAt: leaseExpiresAt,
      drive: {
        accessToken: 'service-account-drive-token',
        expiresAt: tokenExpiresAt,
        scopes: ['drive-scope'],
      },
      app: {
        idToken: 'service-account-id-token',
        expiresAt: tokenExpiresAt,
        audience: 'runme-client',
      },
    })

    const raw = window.localStorage.getItem(
      IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY
    )
    expect(raw).toContain('service-account-drive-token')
    expect(raw).toContain('service-account-id-token')
    expect(raw).not.toContain('human-access-token')
    expect(readImpersonatedServiceAccountCredential()?.drive?.accessToken).toBe(
      'service-account-drive-token'
    )
  })

  it('drops expired targets while retaining an unexpired target', () => {
    window.localStorage.setItem(
      IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        serviceAccount: 'runme@example.iam.gserviceaccount.com',
        humanPrincipal: 'human@example.com',
        createdAt: '2026-08-21T19:00:00.000Z',
        authorizationLeaseExpiresAt: '2026-08-22T20:00:00.000Z',
        drive: {
          accessToken: 'expired-drive-token',
          expiresAt: '2026-08-21T19:59:59.000Z',
          scopes: ['drive-scope'],
        },
        app: {
          idToken: 'valid-id-token',
          expiresAt: '2026-08-21T21:00:00.000Z',
          audience: 'runme-client',
        },
      })
    )

    const credential = readImpersonatedServiceAccountCredential(now)
    expect(credential?.drive).toBeUndefined()
    expect(credential?.app?.idToken).toBe('valid-id-token')
  })

  it('removes credentials after the authorization lease expires', () => {
    window.localStorage.setItem(
      IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        serviceAccount: 'runme@example.iam.gserviceaccount.com',
        humanPrincipal: 'human@example.com',
        createdAt: '2026-08-20T20:00:00.000Z',
        authorizationLeaseExpiresAt: '2026-08-21T19:59:59.000Z',
        drive: {
          accessToken: 'drive-token',
          expiresAt: '2026-08-21T21:00:00.000Z',
          scopes: ['drive-scope'],
        },
      })
    )

    expect(readImpersonatedServiceAccountCredential(now)).toBeNull()
    expect(
      window.localStorage.getItem(
        IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY
      )
    ).toBeNull()
  })

  it('merges target credentials only for the same identity pair', () => {
    mergeImpersonatedServiceAccountCredential({
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
      humanPrincipal: 'human@example.com',
      authorizationLeaseExpiresAt: new Date(
        Date.now() + 86_400_000
      ).toISOString(),
      drive: {
        accessToken: 'drive-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ['drive-scope'],
      },
    })
    const merged = mergeImpersonatedServiceAccountCredential({
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
      humanPrincipal: 'human@example.com',
      authorizationLeaseExpiresAt: new Date(
        Date.now() + 86_400_000
      ).toISOString(),
      app: {
        idToken: 'id-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        audience: 'runme-client',
      },
    })
    expect(merged.drive?.accessToken).toBe('drive-token')
    expect(merged.app?.idToken).toBe('id-token')

    const replaced = mergeImpersonatedServiceAccountCredential({
      serviceAccount: 'other@example.iam.gserviceaccount.com',
      humanPrincipal: 'human@example.com',
      authorizationLeaseExpiresAt: new Date(
        Date.now() + 86_400_000
      ).toISOString(),
      app: {
        idToken: 'other-id-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        audience: 'runme-client',
      },
    })
    expect(replaced.drive).toBeUndefined()
    expect(replaced.app?.idToken).toBe('other-id-token')
  })

  it('clears one target without deleting the other', () => {
    mergeImpersonatedServiceAccountCredential({
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
      humanPrincipal: 'human@example.com',
      authorizationLeaseExpiresAt: new Date(
        Date.now() + 86_400_000
      ).toISOString(),
      drive: {
        accessToken: 'drive-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ['drive-scope'],
      },
      app: {
        idToken: 'id-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        audience: 'runme-client',
      },
    })

    clearImpersonatedServiceAccountCredential(['drive'])
    const remaining = readImpersonatedServiceAccountCredential()
    expect(remaining?.drive).toBeUndefined()
    expect(remaining?.app?.idToken).toBe('id-token')
  })
})
