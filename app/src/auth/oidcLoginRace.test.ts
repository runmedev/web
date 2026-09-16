// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('crypto', webcrypto)
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A superseded discovery request must not replace the new PKCE verifier/state. */
it('ignores delayed discovery from a cancelled login', async () => {
  let release!: (response: Response) => void
  const discovery = new Promise<Response>((resolve) => {
    release = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => discovery)
  )
  const windows: Window[] = []
  vi.spyOn(window, 'open').mockImplementation(() => {
    const child = {
      closed: false,
      close: vi.fn(),
      location: { href: '' },
    } as unknown as Window
    windows.push(child)
    return child
  })
  const { oidcConfigManager } = await import('./oidcConfig')
  oidcConfigManager.setConfig({
    discoveryUrl: 'https://issuer.example/discovery',
    clientId: 'client',
    scope: 'openid',
    redirectUri: window.location.origin + '/oidc/callback',
    authFlow: 'pkce',
    authUxMode: 'popup',
  })
  const { getBrowserAdapter } = await import('../browserAdapter.client')
  const adapter = getBrowserAdapter()
  const first = adapter.loginWithRedirect().catch((error) => error)
  const second = adapter.loginWithRedirect().catch((error) => error)
  release(
    new Response(
      JSON.stringify({
        issuer: 'https://issuer.example',
        authorization_endpoint: 'https://issuer.example/authorize',
        token_endpoint: 'https://issuer.example/token',
      })
    )
  )
  await expect(first).resolves.toBeInstanceOf(Error)
  await vi.waitFor(() =>
    expect(windows[1].location.href).toContain('code_challenge=')
  )
  const request = new URL(windows[1].location.href)
  expect(sessionStorage.getItem('oidc_pkce_state')).toBe(
    request.searchParams.get('state')
  )
  expect(localStorage.getItem('oidc_pkce_state')).toBeNull()
  expect(windows[0].location.href).toBe('')
  adapter.logout()
  expect(sessionStorage.getItem('oidc_pkce_state')).toBeNull()
  expect(sessionStorage.getItem('oidc_pkce_code_verifier')).toBeNull()
  expect(sessionStorage.getItem('oidc_login_config')).toBeNull()
  await expect(second).resolves.toBeInstanceOf(Error)
})
