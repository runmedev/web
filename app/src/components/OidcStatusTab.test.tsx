// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import OidcStatusTab from './OidcStatusTab'
import { getBrowserAdapter } from '../browserAdapter.client'
import { oidcDiagnostics } from '../auth/oidcDiagnostics'
import { oidcConfigManager } from '../auth/oidcConfig'

const token = (claims: unknown) =>
  `e30.${btoa(JSON.stringify(claims))}.fake-signature`
beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  oidcConfigManager.setConfig({
    clientId: 'test-client',
    discoveryUrl: 'https://issuer.example/discovery',
    scope: 'openid email offline_access',
    authFlow: 'pkce',
    authUxMode: 'popup',
  })
  getBrowserAdapter().logout()
})
afterEach(() => vi.useRealTimers())

it('shows signed out and keeps configured flow separate from session provenance', () => {
  render(<OidcStatusTab />)
  expect(screen.getByText('Signed out')).toBeTruthy()
  expect(
    screen.getByTestId('oidc-detail-Next sign-in OAuth flow').textContent
  ).toContain('PKCE')
  expect(
    screen.getByTestId('oidc-detail-Session OAuth flow').textContent
  ).toContain('Not recorded')
})
it('updates when tokens change, expire, and are removed, without displaying raw secrets', async () => {
  render(<OidcStatusTab />)
  const raw = token({
    email: 'person@example.com',
    sub: 'person',
    iss: 'https://issuer.example',
    aud: 'client',
    exp: Date.now() / 1000 + 2,
    secret_claim: 'do-not-display',
  })
  const stored = {
    id_token: raw,
    access_token: 'secret-access',
    refresh_token: 'secret-refresh',
    loginFlow: 'pkce',
    loginInteraction: 'new_tab',
  }
  act(() => {
    localStorage.setItem('oidc-auth', JSON.stringify(stored))
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'oidc-auth',
        newValue: JSON.stringify(stored),
      })
    )
  })
  expect(screen.getByText('person@example.com')).toBeTruthy()
  expect(screen.getByText('Active')).toBeTruthy()
  for (const secret of [
    raw,
    'secret-access',
    'secret-refresh',
    'do-not-display',
  ])
    expect(document.body.textContent).not.toContain(secret)
  await act(() => vi.advanceTimersByTimeAsync(3000))
  expect(screen.getByText('Expired')).toBeTruthy()
  act(() => getBrowserAdapter().logout())
  expect(screen.getByText('Signed out')).toBeTruthy()
  expect(screen.queryByText('person@example.com')).toBeNull()
})
it.each([null, [], 'string', { email: {}, exp: 1e300 }, { exp: 'bad' }])(
  'tolerates malformed claims %j',
  (claims) => {
    const auth = {
      accessToken: '',
      idToken: token(claims),
      isExpired: () => false,
      willExpireSoon: () => false,
    }
    expect(() => oidcDiagnostics(auth)).not.toThrow()
    expect(oidcDiagnostics(auth).idExpiresAt).toBeUndefined()
  }
)
it('identifies a malformed ID token', () => {
  expect(
    oidcDiagnostics({
      accessToken: '',
      idToken: 'broken',
      isExpired: () => false,
      willExpireSoon: () => false,
    }).status
  ).toBe('Unreadable ID token')
})
