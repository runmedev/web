import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getGoogleHumanPrincipal,
  mintImpersonatedServiceAccountCredentials,
  normalizeServiceAccountEmail,
  resolveAuthorizationLeaseSeconds,
} from './googleServiceAccountImpersonation'

function makeUnsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    globalThis
      .btoa(JSON.stringify(value))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
  return `${encode({ alg: 'none' })}.${encode(payload)}.`
}

describe('Google service-account impersonation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('mints separate Drive and Runme credentials for one service account', async () => {
    const idToken = makeUnsignedJwt({ exp: 1_800_000_000 })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: 'drive-token-secret',
            expireTime: '2027-01-15T08:00:00Z',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: idToken }), { status: 200 })
      )

    const result = await mintImpersonatedServiceAccountCredentials({
      humanAccessToken: 'human-token-secret',
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
      driveScopes: ['https://www.googleapis.com/auth/drive'],
      appAudience: 'runme-client.apps.googleusercontent.com',
      accessTokenLifetimeSeconds: 3600,
    })

    expect(result).toEqual({
      driveAccessToken: 'drive-token-secret',
      driveAccessTokenExpiresAt: '2027-01-15T08:00:00Z',
      appIdToken: idToken,
      appIdTokenExpiresAt: new Date(1_800_000_000 * 1000).toISOString(),
      errors: [],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/runme%40example.iam.gserviceaccount.com:generateAccessToken'
    )
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/runme%40example.iam.gserviceaccount.com:generateIdToken'
    )

    const accessRequest = fetchMock.mock.calls[0]?.[1]
    expect(accessRequest?.headers).toEqual({
      Authorization: 'Bearer human-token-secret',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(accessRequest?.body))).toEqual({
      scope: ['https://www.googleapis.com/auth/drive'],
      lifetime: '3600s',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      audience: 'runme-client.apps.googleusercontent.com',
      includeEmail: true,
    })
  })

  it('reads the authorizing human email from Google userinfo', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ email: 'jeremy@lewi.us' }), {
        status: 200,
      })
    )

    await expect(getGoogleHumanPrincipal('human-token')).resolves.toBe(
      'jeremy@lewi.us'
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openidconnect.googleapis.com/v1/userinfo',
      { headers: { Authorization: 'Bearer human-token' } }
    )
  })

  it('mints only the requested credential target', async () => {
    const driveFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: 'drive-only-token',
          expireTime: '2027-01-15T08:00:00Z',
        }),
        { status: 200 }
      )
    )

    await expect(
      mintImpersonatedServiceAccountCredentials({
        humanAccessToken: 'human-token',
        serviceAccount: 'drive@example.iam.gserviceaccount.com',
        driveScopes: ['drive-scope'],
        appAudience: '',
        targets: ['drive'],
      })
    ).resolves.toEqual({
      driveAccessToken: 'drive-only-token',
      driveAccessTokenExpiresAt: '2027-01-15T08:00:00Z',
      errors: [],
    })
    expect(String(driveFetch.mock.calls[0]?.[0])).toContain(
      ':generateAccessToken'
    )
    expect(driveFetch).toHaveBeenCalledTimes(1)

    driveFetch.mockRestore()
    const idToken = makeUnsignedJwt({ exp: 1_800_000_000 })
    const appFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ token: idToken }), { status: 200 })
      )

    await expect(
      mintImpersonatedServiceAccountCredentials({
        humanAccessToken: 'human-token',
        serviceAccount: 'runme@example.iam.gserviceaccount.com',
        driveScopes: [],
        appAudience: 'runme-audience',
        targets: ['app'],
      })
    ).resolves.toEqual({
      appIdToken: idToken,
      appIdTokenExpiresAt: new Date(1_800_000_000 * 1000).toISOString(),
      errors: [],
    })
    expect(String(appFetch.mock.calls[0]?.[0])).toContain(':generateIdToken')
    expect(appFetch).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid service accounts and leases longer than seven days', () => {
    expect(() => normalizeServiceAccountEmail('jeremy@lewi.us')).toThrow(
      'valid Google service-account email'
    )
    expect(() =>
      normalizeServiceAccountEmail(
        'jlewi-runme@runme-lewi.dev.iam.gserviceaccount.com'
      )
    ).toThrow('not a dotted DNS name')
    expect(() => resolveAuthorizationLeaseSeconds(604_801)).toThrow(
      'between 1 and 604800'
    )
  })

  it('surfaces IAM errors without including bearer tokens', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              status: 'PERMISSION_DENIED',
              message: 'Permission denied',
            },
          }),
          { status: 403, statusText: 'Forbidden' }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: makeUnsignedJwt({ exp: 1 }) }), {
          status: 200,
        })
      )

    const result = await mintImpersonatedServiceAccountCredentials({
      humanAccessToken: 'do-not-print-this-token',
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
      driveScopes: ['drive-scope'],
      appAudience: 'runme-audience',
    })
    expect(result.errors).toEqual([
      {
        target: 'drive',
        message:
          'Google IAM generateAccessToken failed (403): Permission denied',
      },
    ])
    expect(JSON.stringify(result)).not.toContain('do-not-print-this-token')
    expect(result.appIdToken).toBeTruthy()
  })
})
