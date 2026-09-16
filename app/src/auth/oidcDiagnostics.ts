import { jwtDecode } from 'jwt-decode'

import type { SimpleAuthJSONWithHelpers } from './types'

/** Project only diagnostic claims: never pass raw tokens or arbitrary claims to the UI. */
export function oidcDiagnostics(
  auth: SimpleAuthJSONWithHelpers | null,
  now = Date.now()
) {
  let claims: Record<string, unknown> = {}
  let malformed = false
  if (auth?.idToken) {
    try {
      const decoded = jwtDecode<unknown>(auth.idToken)
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
        malformed = true
      else claims = decoded as Record<string, unknown>
    } catch {
      malformed = true
    }
  }
  const text = (value: unknown) =>
    typeof value === 'string' ? value : undefined
  const date = (value: unknown) =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= 8.64e15
      ? value
      : undefined
  const idExpiresAt =
    typeof claims.exp === 'number' ? date(claims.exp * 1000) : undefined
  const accessExpiresAt = date(auth?.expiresAt)
  const expired = [idExpiresAt, accessExpiresAt].some(
    (expiry) => expiry !== undefined && expiry <= now
  )
  const hasIdentity = Boolean(auth?.idToken)
  return {
    status: !auth
      ? 'Signed out'
      : malformed
        ? 'Unreadable ID token'
        : !hasIdentity
          ? 'No ID token'
          : expired
            ? 'Expired'
            : idExpiresAt === undefined
              ? 'Expiry unknown'
              : 'Active',
    email: text(claims.email),
    subject: text(claims.sub),
    issuer: text(claims.iss),
    audience:
      text(claims.aud) ??
      (Array.isArray(claims.aud) &&
      claims.aud.every((value) => typeof value === 'string')
        ? claims.aud.join(', ')
        : undefined),
    issuedAt:
      typeof claims.iat === 'number' ? date(claims.iat * 1000) : undefined,
    idExpiresAt,
    accessExpiresAt,
    hasRefreshToken: Boolean(auth?.refreshToken),
    grantedScopes: auth?.scope,
    loginFlow: auth?.loginFlow,
    loginInteraction: auth?.loginInteraction,
  }
}
