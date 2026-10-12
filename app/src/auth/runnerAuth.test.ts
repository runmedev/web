import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearRunnerAuth,
  configureRunnerAuth,
  getRunnerAuthStatus,
  getRunnerIdToken,
  getRunnerTokenForEndpoint,
  resetRunnerAuthForTests,
} from './runnerAuth'
import {
  clearWorkloadIdentityToken,
  configureGoogleWorkloadIdentity,
  getWorkloadIdentityAccessToken,
  getWorkloadIdentityConfig,
  getWorkloadIdentityStatus,
  resetWorkloadIdentityForTests,
} from './workloadIdentity'

const base = {
  runnerName: 'pod',
  runnerBaseUrl: 'https://localhost:9988',
  issuer: 'urn:runme:browser',
  audience: 'urn:runme:runner',
  subject: 'runme',
  keyId: 'test',
}
const drive = {
  authFlow: 'workload_identity' as const,
  runnerName: 'pod',
  expectedServiceAccountEmail: 'runme@project.iam.gserviceaccount.com',
  scopes: ['https://www.googleapis.com/auth/drive'],
  lifetimeSeconds: 900,
}

describe('workload runner credentials', () => {
  let privateKeyPkcs8Pem: string
  let publicKey: CryptoKey
  beforeEach(async () => {
    sessionStorage.clear()
    localStorage.clear()
    resetRunnerAuthForTests()
    resetWorkloadIdentityForTests()
    const pair = await generateKeyPair('ES256', { extractable: true })
    publicKey = pair.publicKey
    privateKeyPkcs8Pem = await exportPKCS8(pair.privateKey)
    await configureRunnerAuth({ ...base, privateKeyPkcs8Pem })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the previous origin protected when a runner name is repointed', async () => {
    clearRunnerAuth({ runnerName: 'pod' })
    await expect(
      configureRunnerAuth({
        ...base,
        runnerBaseUrl: 'https://localhost:9999',
        privateKeyPkcs8Pem,
      })
    ).rejects.toThrow('new runner name')
    await expect(getRunnerTokenForEndpoint(base.runnerBaseUrl)).rejects.toThrow(
      'provisioning'
    )
  })

  it('keeps the workload source renewable after idle expiry and transient failures', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            accessToken: 'google-B',
            tokenType: 'Bearer',
            serviceAccountEmail: drive.expectedServiceAccountEmail,
            scopes: drive.scopes,
            expiresAt: new Date(Date.now() + 899000).toISOString(),
          })
        )
    )
    vi.stubGlobal('fetch', fetcher)
    configureGoogleWorkloadIdentity(drive)
    await getWorkloadIdentityAccessToken()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 910000)
    expect(getWorkloadIdentityStatus()).toMatchObject({
      connected: false,
      canRenew: true,
    })
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await expect(getWorkloadIdentityAccessToken(true)).rejects.toThrow()
    expect(getWorkloadIdentityStatus()?.canRenew).toBe(true)
    await expect(getWorkloadIdentityAccessToken()).resolves.toBe('google-B')
    clearWorkloadIdentityToken()
    expect(getWorkloadIdentityStatus()).toMatchObject({
      connected: false,
      canRenew: false,
    })
    await expect(getWorkloadIdentityAccessToken(true)).rejects.toThrow(
      'disconnected'
    )
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('invalidates cached Google authority when clearing fails to persist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              accessToken: 'google-B',
              tokenType: 'Bearer',
              serviceAccountEmail: drive.expectedServiceAccountEmail,
              scopes: drive.scopes,
              expiresAt: new Date(Date.now() + 899000).toISOString(),
            })
          )
      )
    )
    configureGoogleWorkloadIdentity(drive)
    await getWorkloadIdentityAccessToken()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    expect(() => clearRunnerAuth({ runnerName: 'pod' })).toThrow()
    expect(getWorkloadIdentityStatus()).toMatchObject({
      connected: false,
      canRenew: false,
    })
    await expect(getWorkloadIdentityAccessToken()).rejects.toThrow()
  })

  it('does not invalidate Drive credentials when another runner changes', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            accessToken: 'google-B',
            tokenType: 'Bearer',
            serviceAccountEmail: drive.expectedServiceAccountEmail,
            scopes: drive.scopes,
            expiresAt: new Date(Date.now() + 899000).toISOString(),
          })
        )
    )
    vi.stubGlobal('fetch', fetcher)
    configureGoogleWorkloadIdentity(drive)
    await getWorkloadIdentityAccessToken()
    clearRunnerAuth({ runnerName: 'unrelated' })
    await expect(getWorkloadIdentityAccessToken()).resolves.toBe('google-B')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reuses and renews one verifiable token without persisting secrets', async () => {
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => getRunnerIdToken('pod'))
    )
    expect(new Set(tokens).size).toBe(1)
    const { payload } = await jwtVerify(tokens[0], publicKey, {
      issuer: base.issuer,
      audience: base.audience,
    })
    expect(payload.sub).toBe('runme')
    expect(payload.exp! - payload.iat!).toBe(300)
    expect(await getRunnerTokenForEndpoint('wss://localhost:9988/ws')).toBe(
      tokens[0]
    )
    expect(
      await getRunnerTokenForEndpoint('https://unrelated.example/api')
    ).toBeUndefined()
    const status = JSON.stringify(getRunnerAuthStatus({ runnerName: 'pod' }))
    expect(status).not.toContain(privateKeyPkcs8Pem)
    expect(status).not.toContain(tokens[0])
    expect(JSON.stringify(sessionStorage)).not.toContain('PRIVATE KEY')
    expect(JSON.stringify(sessionStorage)).not.toContain(tokens[0])
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 250000)
    expect(await getRunnerIdToken('pod')).not.toBe(tokens[0])
  })

  it('fails closed after clearing or reloading a signer', async () => {
    clearRunnerAuth({ runnerName: 'pod' })
    await expect(getRunnerTokenForEndpoint(base.runnerBaseUrl)).rejects.toThrow(
      'provisioning'
    )
    resetRunnerAuthForTests()
    expect(getRunnerAuthStatus({ runnerName: 'pod' }).configured).toBe(false)
    await expect(getRunnerTokenForEndpoint(base.runnerBaseUrl)).rejects.toThrow(
      'provisioning'
    )
  })

  it('repeatedly rejects corrupted mode markers instead of selecting human auth', async () => {
    sessionStorage.setItem('runme/runnerAuthDescriptors/v1', '{')
    resetRunnerAuthForTests()
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(
        getRunnerTokenForEndpoint(base.runnerBaseUrl)
      ).rejects.toThrow('Saved runner authentication')
    sessionStorage.setItem('runme/workloadIdentityDrive/v1', '{')
    resetWorkloadIdentityForTests()
    for (let attempt = 0; attempt < 2; attempt++)
      expect(() => getWorkloadIdentityConfig()).toThrow()
  })

  it('does not import unsafe origins or expose malformed private-key input', async () => {
    await expect(
      configureRunnerAuth({
        ...base,
        runnerBaseUrl: 'http://localhost:9988',
        privateKeyPkcs8Pem,
      })
    ).rejects.toThrow('HTTPS')
    await expect(
      configureRunnerAuth({
        ...base,
        privateKeyPkcs8Pem: 'secret-should-never-appear',
      })
    ).rejects.toThrow('Invalid ES256')
  })

  it('requests scoped Google tokens with the same JWT and coalesces concurrent calls', async () => {
    const jwt = await getRunnerIdToken('pod')
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: 'google-B',
          tokenType: 'Bearer',
          serviceAccountEmail: drive.expectedServiceAccountEmail,
          scopes: drive.scopes,
          expiresAt: new Date(Date.now() + 899000).toISOString(),
        })
      )
    )
    vi.stubGlobal('fetch', fetcher)
    configureGoogleWorkloadIdentity(drive)
    expect(
      await Promise.all([
        getWorkloadIdentityAccessToken(),
        getWorkloadIdentityAccessToken(),
      ])
    ).toEqual(['google-B', 'google-B'])
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, request] = fetcher.mock.calls[0]
    expect(url).toBe(base.runnerBaseUrl + '/v1/credentials/google:mint')
    expect(request.headers.Authorization).toBe('Bearer ' + jwt)
    expect(JSON.parse(request.body)).toEqual({
      scopes: drive.scopes,
      lifetimeSeconds: 900,
    })
    expect(request.credentials).toBe('omit')
    expect(request.redirect).toBe('error')
    expect(getWorkloadIdentityStatus()?.effectivePrincipal).toBe(
      drive.expectedServiceAccountEmail
    )
    expect(JSON.stringify(sessionStorage)).not.toContain('google-B')
    clearRunnerAuth({ runnerName: 'pod' })
    await expect(getWorkloadIdentityAccessToken()).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['account', 'scopes', 'expiry'])(
    'rejects an unexpected response: %s',
    async (kind) => {
      const response = {
        accessToken: 'google-B',
        tokenType: 'Bearer',
        serviceAccountEmail: drive.expectedServiceAccountEmail,
        scopes: drive.scopes,
        expiresAt: new Date(Date.now() + 899000).toISOString(),
      }
      if (kind === 'account')
        response.serviceAccountEmail = 'other@project.iam.gserviceaccount.com'
      if (kind === 'scopes')
        response.scopes = ['https://www.googleapis.com/auth/cloud-platform']
      if (kind === 'expiry') response.expiresAt = 'invalid'
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify(response)))
      )
      configureGoogleWorkloadIdentity(drive)
      await expect(getWorkloadIdentityAccessToken()).rejects.toThrow()
      expect(getWorkloadIdentityStatus()?.connected).toBe(false)
    }
  )

  it('discards a mint result when auth changes while the request is in flight', async () => {
    let complete!: (response: Response) => void
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve
        })
    )
    vi.stubGlobal('fetch', fetcher)
    configureGoogleWorkloadIdentity(drive)
    const result = getWorkloadIdentityAccessToken()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    clearRunnerAuth({ runnerName: 'pod' })
    complete(
      new Response(
        JSON.stringify({
          accessToken: 'stale',
          tokenType: 'Bearer',
          serviceAccountEmail: drive.expectedServiceAccountEmail,
          scopes: drive.scopes,
          expiresAt: new Date(Date.now() + 899000).toISOString(),
        })
      )
    )
    await expect(result).rejects.toThrow()
    expect(getWorkloadIdentityStatus()?.connected).toBe(false)
  })
})
