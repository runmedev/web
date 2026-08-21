import { jwtDecode } from 'jwt-decode'

export const GOOGLE_SERVICE_ACCOUNT_IMPERSONATION_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/cloud-platform',
]

const IAM_CREDENTIALS_BASE_URL =
  'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts'
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 3600
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 43200
const DEFAULT_AUTHORIZATION_LEASE_SECONDS = 24 * 60 * 60
const MAX_AUTHORIZATION_LEASE_SECONDS = 7 * 24 * 60 * 60

type GoogleApiError = {
  error?: {
    code?: number
    message?: string
    status?: string
  }
}

type GenerateAccessTokenResponse = {
  accessToken?: string
  expireTime?: string
}

type GenerateIdTokenResponse = {
  token?: string
}

type GoogleUserInfoResponse = {
  email?: string
}

export type GetServiceAccountCredentialsOptions = {
  driveScopes?: string[]
  appAudience?: string
  humanAccount?: string
  mode?: 'popup' | 'redirect' | 'new_tab'
  authorizationLeaseSeconds?: number
  accessTokenLifetimeSeconds?: number
  prompt?: '' | 'none' | 'consent' | 'select_account'
  targets?: ServiceAccountCredentialTarget[]
}

export type ServiceAccountCredentialTarget = 'drive' | 'app'

export type ServiceAccountCredentialStatus = {
  status: 'started' | 'authorized' | 'partial'
  humanPrincipal: string
  serviceAccount: string
  authorizationLeaseExpiresAt: string
  drive?: {
    scopes: string[]
    expiresAt: string
  }
  app?: {
    audience: string
    expiresAt: string
  }
  errors?: ServiceAccountCredentialTargetError[]
}

export type ServiceAccountCredentialTargetError = {
  target: ServiceAccountCredentialTarget
  message: string
}

export type MintImpersonatedServiceAccountCredentialsRequest = {
  humanAccessToken: string
  serviceAccount: string
  driveScopes: string[]
  appAudience: string
  targets?: ServiceAccountCredentialTarget[]
  accessTokenLifetimeSeconds?: number
}

export type MintedImpersonatedServiceAccountCredentials = {
  driveAccessToken?: string
  driveAccessTokenExpiresAt?: string
  appIdToken?: string
  appIdTokenExpiresAt?: string
  errors: ServiceAccountCredentialTargetError[]
}

/**
 * Normalizes a target service-account email before it is interpolated into an
 * IAM Credentials API resource name. The API intentionally uses the `-`
 * project wildcard and authorizes the caller against the specific account.
 */
export function normalizeServiceAccountEmail(serviceAccount: string): string {
  const normalized = serviceAccount.trim()
  if (
    !normalized ||
    !/^[^\s/@]+@[^\s/@]+\.iam\.gserviceaccount\.com$/.test(normalized)
  ) {
    throw new Error('A valid Google service-account email is required.')
  }
  return normalized
}

/** Validates the product-level authorization lease requested by the caller. */
export function resolveAuthorizationLeaseSeconds(value?: number): number {
  const resolved = value ?? DEFAULT_AUTHORIZATION_LEASE_SECONDS
  if (
    !Number.isInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_AUTHORIZATION_LEASE_SECONDS
  ) {
    throw new Error('authorizationLeaseSeconds must be between 1 and 604800.')
  }
  return resolved
}

function resolveAccessTokenLifetimeSeconds(value?: number): number {
  const resolved = value ?? DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS
  if (
    !Number.isInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_ACCESS_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error('accessTokenLifetimeSeconds must be between 1 and 43200.')
  }
  return resolved
}

async function readGoogleApiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as GoogleApiError
    return body.error?.message ?? body.error?.status ?? response.statusText
  } catch {
    return response.statusText
  }
}

async function postIamCredentials<T>(
  humanAccessToken: string,
  serviceAccount: string,
  method: 'generateAccessToken' | 'generateIdToken',
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(
    `${IAM_CREDENTIALS_BASE_URL}/${encodeURIComponent(serviceAccount)}:${method}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${humanAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  )

  if (!response.ok) {
    const detail = await readGoogleApiError(response)
    throw new Error(
      `Google IAM ${method} failed (${response.status}): ${detail}`
    )
  }
  return (await response.json()) as T
}

/** Resolves the authorizing human identity without exposing the OAuth token. */
export async function getGoogleHumanPrincipal(
  humanAccessToken: string
): Promise<string> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${humanAccessToken}` },
  })
  if (!response.ok) {
    throw new Error(
      `Google userinfo request failed (${response.status}): ${await readGoogleApiError(response)}`
    )
  }
  const body = (await response.json()) as GoogleUserInfoResponse
  const email = body.email?.trim()
  if (!email) {
    throw new Error('Google userinfo response did not contain an email.')
  }
  return email
}

/**
 * Uses a short-lived human Google token to mint keyless credentials for a
 * service account. Drive and Runme receive distinct token types even though
 * they use the same effective service-account identity.
 */
export async function mintImpersonatedServiceAccountCredentials(
  request: MintImpersonatedServiceAccountCredentialsRequest
): Promise<MintedImpersonatedServiceAccountCredentials> {
  const humanAccessToken = request.humanAccessToken.trim()
  if (!humanAccessToken) {
    throw new Error('A human Google OAuth access token is required.')
  }
  const serviceAccount = normalizeServiceAccountEmail(request.serviceAccount)
  const targets = new Set(request.targets ?? ['drive', 'app'])
  if (targets.size === 0) {
    throw new Error(
      'At least one service-account credential target is required.'
    )
  }
  const driveScopes = request.driveScopes
    .map((scope) => scope.trim())
    .filter(Boolean)
  if (targets.has('drive') && driveScopes.length === 0) {
    throw new Error('At least one Google Drive scope is required.')
  }
  const appAudience = request.appAudience.trim()
  if (targets.has('app') && !appAudience) {
    throw new Error('A Runme application audience is required.')
  }
  const lifetimeSeconds = resolveAccessTokenLifetimeSeconds(
    request.accessTokenLifetimeSeconds
  )

  const [driveResult, idResult] = await Promise.allSettled([
    targets.has('drive')
      ? postIamCredentials<GenerateAccessTokenResponse>(
          humanAccessToken,
          serviceAccount,
          'generateAccessToken',
          {
            scope: driveScopes,
            lifetime: `${lifetimeSeconds}s`,
          }
        )
      : undefined,
    targets.has('app')
      ? postIamCredentials<GenerateIdTokenResponse>(
          humanAccessToken,
          serviceAccount,
          'generateIdToken',
          {
            audience: appAudience,
            includeEmail: true,
          }
        )
      : undefined,
  ])

  const errors: ServiceAccountCredentialTargetError[] = []
  const driveResponse =
    driveResult.status === 'fulfilled' ? driveResult.value : undefined
  const idResponse =
    idResult.status === 'fulfilled' ? idResult.value : undefined
  if (driveResult.status === 'rejected') {
    errors.push({
      target: 'drive',
      message:
        driveResult.reason instanceof Error
          ? driveResult.reason.message
          : String(driveResult.reason),
    })
  }
  if (idResult.status === 'rejected') {
    errors.push({
      target: 'app',
      message:
        idResult.reason instanceof Error
          ? idResult.reason.message
          : String(idResult.reason),
    })
  }

  if (
    driveResponse &&
    (!driveResponse.accessToken || !driveResponse.expireTime)
  ) {
    errors.push({
      target: 'drive',
      message: 'Google IAM access-token response was incomplete.',
    })
  }
  if (idResponse && !idResponse.token) {
    errors.push({
      target: 'app',
      message: 'Google IAM ID-token response was incomplete.',
    })
  }
  let appIdTokenExpiresAt: string | undefined
  if (idResponse?.token) {
    try {
      const decoded = jwtDecode<{ exp?: number }>(idResponse.token)
      if (!decoded.exp) {
        throw new Error(
          'Google IAM ID token did not contain an expiration time.'
        )
      }
      appIdTokenExpiresAt = new Date(decoded.exp * 1000).toISOString()
    } catch (error) {
      errors.push({
        target: 'app',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    ...(driveResponse?.accessToken && driveResponse.expireTime
      ? {
          driveAccessToken: driveResponse.accessToken,
          driveAccessTokenExpiresAt: driveResponse.expireTime,
        }
      : {}),
    ...(idResponse?.token && appIdTokenExpiresAt
      ? { appIdToken: idResponse.token, appIdTokenExpiresAt }
      : {}),
    errors,
  }
}
