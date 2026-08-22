import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getGoogleHumanPrincipal,
  mintImpersonatedServiceAccountCredentials,
  normalizeServiceAccountEmail,
  resolveAuthorizationLeaseSeconds,
  validateImpersonatedGoogleDriveAccessToken,
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

  it('requests a one-hour Drive token by default', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: 'drive-token',
          expireTime: '2027-01-15T20:00:00Z',
        }),
        { status: 200 }
      )
    )

    await mintImpersonatedServiceAccountCredentials({
      humanAccessToken: 'human-token',
      serviceAccount: 'drive@example.iam.gserviceaccount.com',
      driveScopes: ['drive-scope'],
      appAudience: '',
      targets: ['drive'],
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      scope: ['drive-scope'],
      lifetime: '3600s',
    })
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

  it('explains how to enable a disabled IAM Credentials API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            status: 'PERMISSION_DENIED',
            message:
              'IAM Service Account Credentials API has not been used in project 554943104515 before or it is disabled.',
            details: [
              {
                reason: 'SERVICE_DISABLED',
                metadata: {
                  consumer: 'projects/554943104515',
                  service: 'iamcredentials.googleapis.com',
                },
              },
            ],
          },
        }),
        { status: 403, statusText: 'Forbidden' }
      )
    )

    const result = await mintImpersonatedServiceAccountCredentials({
      humanAccessToken: 'human-token',
      serviceAccount: 'drive@example.iam.gserviceaccount.com',
      driveScopes: ['drive-scope'],
      appAudience: '',
      targets: ['drive'],
    })

    expect(result.errors[0]?.message).toContain(
      'IAM Service Account Credentials API is not enabled for OAuth client/quota project 554943104515'
    )
    expect(result.errors[0]?.message).toContain(
      'https://console.cloud.google.com/apis/library/iamcredentials.googleapis.com?project=554943104515'
    )
    expect(result.errors[0]?.message).toContain('wait a few minutes')
  })

  it('explains how to enable a disabled Drive API before installing the token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            status: 'PERMISSION_DENIED',
            message:
              'Google Drive API has not been used in project 123456 before or it is disabled.',
            details: [
              {
                reason: 'SERVICE_DISABLED',
                metadata: {
                  consumer: 'projects/123456',
                  service: 'drive.googleapis.com',
                },
              },
            ],
          },
        }),
        { status: 403, statusText: 'Forbidden' }
      )
    )

    await expect(
      validateImpersonatedGoogleDriveAccessToken(
        'do-not-print-this-token',
        'runme@runme-lewi-dev.iam.gserviceaccount.com'
      )
    ).rejects.toThrow(
      /Google Drive API is not enabled for service-account project 123456.*https:\/\/console\.cloud\.google\.com\/apis\/library\/drive\.googleapis\.com\?project=123456/
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)',
      { headers: { Authorization: 'Bearer do-not-print-this-token' } }
    )
  })

  it('explains the organization policy needed above one hour', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message:
              'The specified credential lifetime of 43200s exceeds the max allowed lifetime of 3600s. Configure constraints/iam.allowServiceAccountCredentialLifetimeExtension.',
          },
        }),
        { status: 400, statusText: 'Bad Request' }
      )
    )

    const result = await mintImpersonatedServiceAccountCredentials({
      humanAccessToken: 'human-token',
      serviceAccount: 'drive@example.iam.gserviceaccount.com',
      driveScopes: ['drive-scope'],
      appAudience: '',
      targets: ['drive'],
    })

    expect(result.errors[0]?.message).toContain(
      'Google rejected the requested service-account token lifetime above one hour'
    )
    expect(result.errors[0]?.message).toContain(
      'constraints/iam.allowServiceAccountCredentialLifetimeExtension'
    )
  })
})
