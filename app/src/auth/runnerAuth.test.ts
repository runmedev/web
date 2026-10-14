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

  it.each([
    'http://localhost:9988',
    'http://127.0.0.1:9988',
    'http://127.0.0.2:9988',
    'http://[::1]:9988',
  ])(
    'signs for HTTP loopback %s and its matching WebSocket origin',
    async (runnerBaseUrl) => {
      await configureRunnerAuth({
        ...base,
        runnerName: 'local',
        runnerBaseUrl,
        privateKeyPkcs8Pem,
      })
      const token = await getRunnerTokenForEndpoint(
        runnerBaseUrl.replace('http:', 'ws:') + '/ws'
      )
      await expect(
        jwtVerify(token!, publicKey, {
          issuer: base.issuer,
          audience: base.audience,
        })
      ).resolves.toBeDefined()
      expect(
        await getRunnerTokenForEndpoint(runnerBaseUrl.replace(':9988', ':9989'))
      ).toBeUndefined()
    }
  )

  it.each([
    'http://localhost.example:9988',
    'http://192.168.1.1:9988',
    'http://0.0.0.0:9988',
    'http://localhost:9988/path',
    'http://localhost:9988?x=1',
    'http://user@localhost:9988',
    'ws://localhost:9988',
    'http://localhost.:9988',
  ])('rejects non-loopback or non-origin input %s', async (runnerBaseUrl) => {
    await expect(
      configureRunnerAuth({
        ...base,
        runnerName: 'local',
        runnerBaseUrl,
        privateKeyPkcs8Pem,
      })
    ).rejects.toThrow('origin')
  })

  it('restores the provisioned signer after reload and after a fresh tab session', async () => {
    await getRunnerIdToken('pod')
    sessionStorage.clear()
    resetRunnerAuthForTests()
    expect(getRunnerAuthStatus({ runnerName: 'pod' })).toMatchObject({
      configured: true,
      tokenExpiresAt: undefined,
    })
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => getRunnerIdToken('pod'))
    )
    expect(new Set(tokens).size).toBe(1)
    await expect(
      jwtVerify(tokens[0], publicKey, {
        issuer: base.issuer,
        audience: base.audience,
      })
    ).resolves.toBeDefined()
    clearRunnerAuth({ runnerName: 'pod' })
    expect(localStorage.getItem('runme/runnerAuth/v2')).not.toContain(
      'PRIVATE KEY'
    )
    resetRunnerAuthForTests()
    await expect(getRunnerIdToken('pod')).rejects.toThrow('provisioning')
  })

  it('retains legacy session markers until the signer is provisioned once', async () => {
    localStorage.removeItem('runme/runnerAuth/v2')
    sessionStorage.setItem(
      'runme/runnerAuthDescriptors/v1',
      JSON.stringify([base])
    )
    resetRunnerAuthForTests()
    await expect(getRunnerIdToken('pod')).rejects.toThrow('provisioning')
    await configureRunnerAuth({ ...base, privateKeyPkcs8Pem })
    resetRunnerAuthForTests()
    await expect(getRunnerIdToken('pod')).resolves.toBeTruthy()
  })

  it('keeps legacy origin bindings when another tab has provisioned a different runner', async () => {
    sessionStorage.setItem(
      'runme/runnerAuthDescriptors/v1',
      JSON.stringify([
        {
          ...base,
          runnerName: 'legacy',
          runnerBaseUrl: 'https://legacy.example',
        },
      ])
    )
    resetRunnerAuthForTests()
    await expect(getRunnerIdToken('pod')).resolves.toBeTruthy()
    await expect(
      getRunnerTokenForEndpoint('https://legacy.example')
    ).rejects.toThrow('provisioning')
    await configureRunnerAuth({ ...base, privateKeyPkcs8Pem })
    sessionStorage.clear()
    resetRunnerAuthForTests()
    await expect(
      getRunnerTokenForEndpoint('https://legacy.example')
    ).rejects.toThrow('provisioning')
  })

  it('fails closed for a malformed persisted key and never reflects key contents', async () => {
    localStorage.setItem(
      'runme/runnerAuth/v2',
      JSON.stringify([{ ...base, privateKeyPkcs8Pem: 'secret-invalid-pem' }])
    )
    resetRunnerAuthForTests()
    await expect(getRunnerIdToken('pod')).rejects.toThrow(
      /^Invalid ES256 runner signing key; provision it again$/
    )
  })

  it('observes key rotation and clearing from another tab before using cached authority', async () => {
    const old = await getRunnerIdToken('pod')
    const pair = await generateKeyPair('ES256', { extractable: true })
    const pem = await exportPKCS8(pair.privateKey)
    localStorage.setItem(
      'runme/runnerAuth/v2',
      JSON.stringify([{ ...base, privateKeyPkcs8Pem: pem }])
    )
    const token = await getRunnerIdToken('pod')
    expect(token).not.toBe(old)
    await expect(jwtVerify(token, pair.publicKey)).resolves.toBeDefined()
    localStorage.setItem('runme/runnerAuth/v2', JSON.stringify([base]))
    await expect(getRunnerIdToken('pod')).rejects.toThrow('provisioning')
  })

  it('persists the imported key snapshot if the caller mutates its input during import', async () => {
    const input = { ...base, privateKeyPkcs8Pem }
    const configured = configureRunnerAuth(input)
    input.privateKeyPkcs8Pem = 'changed during asynchronous import'
    await configured
    resetRunnerAuthForTests()
    await expect(
      jwtVerify(await getRunnerIdToken('pod'), publicKey)
    ).resolves.toBeDefined()
  })

  it('rejects persistence failure without replacing a working signer', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true })
    const pem = await exportPKCS8(pair.privateKey)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('secret storage error')
    })
    await expect(
      configureRunnerAuth({ ...base, privateKeyPkcs8Pem: pem })
    ).rejects.toThrow(/^Unable to save runner authentication configuration$/)
    await expect(
      jwtVerify(await getRunnerIdToken('pod'), publicKey)
    ).resolves.toBeDefined()
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

  it('reuses and renews tokens while persisting only the provisioned signer', async () => {
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
    expect(
      JSON.parse(localStorage.getItem('runme/runnerAuth/v2')!)[0]
        .privateKeyPkcs8Pem
    ).toBe(privateKeyPkcs8Pem)
    expect(JSON.stringify(localStorage)).not.toContain(tokens[0])
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
    localStorage.setItem('runme/runnerAuth/v2', '{')
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
        runnerBaseUrl: 'http://runner.example:9988',
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

  it('restores the signer for Google minting and invalidates Google tokens on a cross-tab clear', async () => {
    configureGoogleWorkloadIdentity(drive)
    resetRunnerAuthForTests()
    resetWorkloadIdentityForTests()
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            accessToken: 'google-restored',
            tokenType: 'Bearer',
            serviceAccountEmail: drive.expectedServiceAccountEmail,
            scopes: drive.scopes,
            expiresAt: new Date(Date.now() + 899000).toISOString(),
          })
        )
    )
    vi.stubGlobal('fetch', fetcher)
    await expect(getWorkloadIdentityAccessToken()).resolves.toBe(
      'google-restored'
    )
    localStorage.setItem('runme/runnerAuth/v2', JSON.stringify([base]))
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'runme/runnerAuth/v2',
        storageArea: localStorage,
      })
    )
    expect(getWorkloadIdentityStatus()).toMatchObject({
      connected: false,
      canRenew: false,
    })
    await expect(getWorkloadIdentityAccessToken()).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('discards a token when the signer is cleared during lazy import', async () => {
    resetRunnerAuthForTests()
    const pending = getRunnerIdToken('pod')
    clearRunnerAuth({ runnerName: 'pod' })
    await expect(pending).rejects.toThrow('changed')
    await expect(getRunnerIdToken('pod')).rejects.toThrow('provisioning')
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
