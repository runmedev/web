import { base64url, createRemoteJWKSet, jwtVerify } from 'jose'

import type { OidcConfig } from './oidcConfig'
import type { OAuthTokenEndpointResponse } from './types'

const TRANSACTION_KEY = 'google_oidc_transaction'
const DISCOVERY_URL =
  'https://accounts.google.com/.well-known/openid-configuration'
const googleKeys = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs')
)
const MAX_LOGIN_AGE_MS = 10 * 60 * 1000

type LoginTransaction = {
  state: string
  nonce: string
  clientId: string
  redirectUri: string
  createdAt: number
}

/** Google web clients cannot exchange authorization codes without a secret. */
export function usesGoogleImplicitLogin(config: OidcConfig): boolean {
  return config.discoveryUrl === DISCOVERY_URL && !config.clientSecret?.trim()
}

/** Keep this login attempt in the initiating tab, separate from Drive OAuth. */
export function beginGoogleImplicitLogin(
  config: OidcConfig,
  loginHint?: string
): string {
  const transaction: LoginTransaction = {
    state: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    createdAt: Date.now(),
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
    url.searchParams.set(key, value)
  }
  // These protocol parameters cannot be overridden by custom auth parameters.
  url.searchParams.set('client_id', transaction.clientId)
  url.searchParams.set('redirect_uri', transaction.redirectUri)
  url.searchParams.set('response_type', 'id_token token')
  url.searchParams.set('response_mode', 'fragment')
  url.searchParams.set('scope', config.scope)
  url.searchParams.set('state', transaction.state)
  url.searchParams.set('nonce', transaction.nonce)
  url.searchParams.set('access_type', 'online')
  url.searchParams.delete('code_challenge')
  url.searchParams.delete('code_challenge_method')
  url.searchParams.delete('client_secret')
  if (loginHint?.trim()) url.searchParams.set('login_hint', loginHint.trim())
  window.sessionStorage.setItem(TRANSACTION_KEY, JSON.stringify(transaction))
  return url.toString()
}

/** Clear pending login state on logout or when selecting another login flow. */
export function clearGoogleImplicitLogin(): void {
  window.sessionStorage.removeItem(TRANSACTION_KEY)
}

/** Only a login initiated in this tab may consume an implicit callback. */
export function hasGoogleImplicitLogin(): boolean {
  return window.sessionStorage.getItem(TRANSACTION_KEY) !== null
}

/** Validate a front-channel response before any token enters persistent storage. */
export async function finishGoogleImplicitLogin(
  callbackUrl: URL,
  config: OidcConfig
): Promise<OAuthTokenEndpointResponse> {
  const raw = window.sessionStorage.getItem(TRANSACTION_KEY)
  clearGoogleImplicitLogin()
  // Remove tokens even when validation fails, before the route logs or navigates.
  window.history.replaceState(
    null,
    '',
    callbackUrl.pathname + callbackUrl.search
  )
  if (!raw) throw new Error('No pending Google login')
  const transaction = JSON.parse(raw) as LoginTransaction
  const age = Date.now() - transaction.createdAt
  if (
    !usesGoogleImplicitLogin(config) ||
    !transaction.state ||
    !transaction.nonce ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > MAX_LOGIN_AGE_MS ||
    transaction.clientId !== config.clientId ||
    transaction.redirectUri !== config.redirectUri ||
    callbackUrl.origin + callbackUrl.pathname !== config.redirectUri
  )
    throw new Error('Google login transaction expired or configuration changed')

  const params = new URLSearchParams(callbackUrl.hash.slice(1))
  for (const key of [
    'state',
    'id_token',
    'access_token',
    'token_type',
    'expires_in',
    'error',
  ]) {
    if (params.getAll(key).length > 1)
      throw new Error('Duplicate Google callback parameter')
  }
  if (params.get('state') !== transaction.state)
    throw new Error('Google login state mismatch')
  if (params.has('error')) throw new Error('Google login was denied or failed')
  const idToken = params.get('id_token')
  const accessToken = params.get('access_token')
  const expiresIn = Number(params.get('expires_in'))
  if (
    !idToken ||
    !accessToken ||
    params.get('token_type')?.toLowerCase() !== 'bearer' ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error('Google callback is missing valid tokens or expiry')
  }
  // Unlike a token-endpoint response, a URL fragment requires signature validation.
  const { payload } = await jwtVerify(idToken, googleKeys, {
    algorithms: ['RS256'],
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: transaction.clientId,
    requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce', 'at_hash'],
    maxTokenAge: '10m',
  })
  if (typeof payload.sub !== 'string' || !payload.sub)
    throw new Error('Google ID token subject is missing')
  if (payload.nonce !== transaction.nonce)
    throw new Error('Google login nonce mismatch')
  if (
    (payload.azp !== undefined && payload.azp !== transaction.clientId) ||
    (Array.isArray(payload.aud) &&
      payload.aud.length > 1 &&
      payload.azp !== transaction.clientId)
  ) {
    throw new Error('Google ID token authorized party mismatch')
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(accessToken)
  )
  if (
    payload.at_hash !== base64url.encode(new Uint8Array(digest).slice(0, 16))
  ) {
    throw new Error('Google access token hash mismatch')
  }
  return {
    access_token: accessToken,
    id_token: idToken,
    token_type: 'Bearer',
    scope: params.get('scope') ?? config.scope,
    expires_in: Math.min(expiresIn, payload.exp! - Date.now() / 1000),
  }
}
