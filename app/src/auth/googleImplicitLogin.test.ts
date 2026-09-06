// @vitest-environment jsdom
import { SignJWT, base64url, exportJWK, generateKeyPair } from 'jose'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import localAppConfigYaml from '../../assets/configs/app-configs.yaml?raw'

describe('secret-free Google OIDC login', () => {
  let login: typeof import('./googleImplicitLogin')
  let adapter: import('../browserAdapter.client').BrowserAuthAdapter
  let config: import('./oidcConfig').OidcConfig
  let privateKey: CryptoKey
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('crypto', webcrypto)
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.history.replaceState(null, '', '/')
    const keys = await generateKeyPair('RS256')
    privateKey = keys.privateKey
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'google-test-key' }
    fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) !== 'https://www.googleapis.com/oauth2/v3/certs') {
        throw new Error('Unexpected network request')
      }
      return new Response(JSON.stringify({ keys: [jwk] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { setAppConfigFromYaml } = await import('../lib/appConfig')
    config = setAppConfigFromYaml(
      localAppConfigYaml,
      'http://localhost/configs/app-configs.yaml'
    ).oidc!
    login = await import('./googleImplicitLogin')
    adapter = new (
      await import('../browserAdapter.client')
    ).BrowserAuthAdapter()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** Sign a realistic front-channel response; only Google's public-key fetch is mocked. */
  async function callback(
    claims: Record<string, unknown> = {},
    parameters: Record<string, string> = {}
  ) {
    const request = new URL(login.beginGoogleImplicitLogin(config))
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('access-token')
    )
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({
      iss: 'https://accounts.google.com',
      sub: 'test-user',
      aud: config.clientId,
      iat: now,
      exp: now + 1800,
      nonce: request.searchParams.get('nonce'),
      at_hash: base64url.encode(new Uint8Array(digest).slice(0, 16)),
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'google-test-key' })
      .sign(privateKey)
    const params = new URLSearchParams({
      state: request.searchParams.get('state')!,
      id_token: token,
      access_token: 'access-token',
      token_type: 'Bearer',
      expires_in: '3600',
      ...parameters,
    })
    window.history.replaceState(
      null,
      '',
      new URL(config.redirectUri).pathname + '#' + params
    )
    return token
  }

  it('routes the shipped configuration to a secret-free Google browser login', async () => {
    let authorizationUrl = ''
    const begin = login.beginGoogleImplicitLogin
    vi.spyOn(login, 'beginGoogleImplicitLogin').mockImplementation(
      (c, hint) => {
        authorizationUrl = begin(c, hint)
        return window.location.href // Avoid navigating jsdom away from the test.
      }
    )
    await adapter.loginWithRedirect({ loginHint: 'user@example.com' })
    const request = new URL(authorizationUrl)
    expect(request.origin).toBe('https://accounts.google.com')
    expect(request.searchParams.get('response_type')).toBe('id_token token')
    expect(request.searchParams.get('access_type')).toBe('online')
    expect(request.searchParams.get('login_hint')).toBe('user@example.com')
    expect(request.searchParams.has('code_challenge')).toBe(false)
    expect(request.searchParams.has('client_secret')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(
      login.usesGoogleImplicitLogin({
        ...config,
        discoveryUrl: 'https://issuer.example/discovery',
      })
    ).toBe(false)
    expect(
      login.usesGoogleImplicitLogin({
        ...config,
        clientSecret: 'private-config',
      })
    ).toBe(false)
  })

  it('verifies and persists tokens without a code exchange or an old refresh token', async () => {
    window.localStorage.setItem(
      'oidc-auth',
      JSON.stringify({ access_token: 'old', refresh_token: 'old-refresh' })
    )
    const idToken = await callback()
    await Promise.all([adapter.handleCallback(), adapter.handleCallback()])
    expect(adapter.simpleAuth).toMatchObject({
      accessToken: 'access-token',
      idToken,
      tokenType: 'Bearer',
    })
    expect(adapter.simpleAuth?.refreshToken).toBeUndefined()
    expect(adapter.simpleAuth?.expiresAt).toBeLessThanOrEqual(
      Date.now() + 1800_000
    )
    expect(window.location.hash).toBe('')
    expect(login.hasGoogleImplicitLogin()).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await adapter.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(adapter.handleCallback()).rejects.toThrow()
  })

  it.each([
    ['issuer', { iss: 'https://attacker.example' }],
    ['audience', { aud: 'other-client' }],
    ['expiry', { exp: 1 }],
    ['nonce', { nonce: 'other-login' }],
    ['access-token hash', { at_hash: 'wrong' }],
    ['authorized party', { azp: 'other-client' }],
    [
      'multiple audiences without authorized party',
      { aud: ['current-client', 'other-client'] },
    ],
  ])(
    'rejects an invalid %s without persisting credentials',
    async (_name, claims) => {
      // Resolve the current client at test time for the multi-audience case.
      if ('aud' in claims && Array.isArray(claims.aud))
        claims = { aud: [config.clientId, 'other-client'] }
      await callback(claims)
      await expect(adapter.handleCallback()).rejects.toThrow()
      expect(adapter.simpleAuth).toBeNull()
      expect(window.location.hash).toBe('')
      expect(login.hasGoogleImplicitLogin()).toBe(false)
    }
  )

  it.each([
    ['state', { state: 'wrong-state' }],
    ['missing ID token', { id_token: '' }],
    ['access-token substitution', { access_token: 'other-token' }],
    ['expiry', { expires_in: 'NaN' }],
    ['OAuth denial', { error: 'access_denied' }],
  ])('rejects a callback with invalid %s', async (_name, parameters) => {
    await callback({}, parameters)
    await expect(adapter.handleCallback()).rejects.toThrow()
    expect(adapter.simpleAuth).toBeNull()
    expect(window.location.hash).toBe('')
  })

  it('rejects a token signed by a different key', async () => {
    privateKey = (await generateKeyPair('RS256')).privateKey
    await callback()
    await expect(adapter.handleCallback()).rejects.toThrow()
    expect(adapter.simpleAuth).toBeNull()
  })

  it('rejects stale transactions', async () => {
    await callback()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000)
    await expect(adapter.handleCallback()).rejects.toThrow('expired')
    expect(adapter.simpleAuth).toBeNull()
  })

  it('does not restore credentials if the user logs out during verification', async () => {
    await callback()
    const pending = adapter.handleCallback()
    adapter.logout()
    await expect(pending).rejects.toThrow('superseded')
    expect(adapter.simpleAuth).toBeNull()
  })

  it('rejects duplicate callback state and consumes the transaction', async () => {
    await callback()
    window.history.replaceState(null, '', window.location.href + '&state=other')
    await expect(adapter.handleCallback()).rejects.toThrow('Duplicate')
    expect(login.hasGoogleImplicitLogin()).toBe(false)
    expect(adapter.simpleAuth).toBeNull()
  })

  it('rejects a callback at a different redirect path', async () => {
    await callback()
    window.history.replaceState(
      null,
      '',
      '/other-callback' + window.location.hash
    )
    await expect(adapter.handleCallback()).rejects.toThrow(
      'configuration changed'
    )
    expect(adapter.simpleAuth).toBeNull()
  })
})
