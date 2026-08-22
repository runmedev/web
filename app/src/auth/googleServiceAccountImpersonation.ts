import { jwtDecode } from 'jwt-decode'

import { isGoogleServiceAccountEmail } from './appLoginConfiguration'

export const GOOGLE_SERVICE_ACCOUNT_IMPERSONATION_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/cloud-platform',
]

const IAM_CREDENTIALS_BASE_URL =
  'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts'
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const GOOGLE_DRIVE_ABOUT_URL =
  'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)'
export const DEFAULT_IMPERSONATED_ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 43200
const DEFAULT_AUTHORIZATION_LEASE_SECONDS = 24 * 60 * 60
const MAX_AUTHORIZATION_LEASE_SECONDS = 7 * 24 * 60 * 60

type GoogleApiError = {
  error?: {
    code?: number
    message?: string
    status?: string
    details?: Array<{
      reason?: string
      metadata?: Record<string, string>
    }>
  }
}

type ParsedGoogleApiError = {
  message: string
  reason?: string
  metadata?: Record<string, string>
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

export function getServiceAccountCredentialStatusError(
  status: ServiceAccountCredentialStatus
): string | null {
  if (status.status !== 'partial') {
    return null
  }
  return (
    status.errors
      ?.map((error) => `${error.target}: ${error.message}`)
      .join('; ') || 'Service-account authorization completed only partially.'
  )
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
  if (!isGoogleServiceAccountEmail(normalized)) {
    throw new Error(
      'A valid Google service-account email is required. Use the Google Cloud project ID (for example, project-name), not a dotted DNS name.'
    )
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
  const resolved =
    value ?? DEFAULT_IMPERSONATED_ACCESS_TOKEN_LIFETIME_SECONDS
  if (
    !Number.isInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_ACCESS_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error('accessTokenLifetimeSeconds must be between 1 and 43200.')
  }
  return resolved
}

async function readGoogleApiError(
  response: Response
): Promise<ParsedGoogleApiError> {
  try {
    const body = (await response.json()) as GoogleApiError
    const errorInfo =
      body.error?.details?.find(
        (detail) => detail.reason === 'SERVICE_DISABLED'
      ) ??
      body.error?.details?.find((detail) => detail.reason || detail.metadata)
    return {
      message:
        body.error?.message ?? body.error?.status ?? response.statusText,
      reason: errorInfo?.reason,
      metadata: errorInfo?.metadata,
    }
  } catch {
    return { message: response.statusText }
  }
}

function formatIamCredentialsError(
  method: 'generateAccessToken' | 'generateIdToken',
  status: number,
  detail: ParsedGoogleApiError
): string {
  const service = detail.metadata?.service
  const isIamCredentialsDisabled =
    detail.reason === 'SERVICE_DISABLED' &&
    (!service || service === 'iamcredentials.googleapis.com')
  const disabledProjectFromMessage = detail.message.match(
    /(?:used in|for) project ([a-z0-9-]+)/i
  )?.[1]

  if (
    isIamCredentialsDisabled ||
    /IAM Service Account Credentials API.*(?:disabled|not been used)/i.test(
      detail.message
    )
  ) {
    const consumer = detail.metadata?.consumer?.replace(/^projects\//, '')
    const project = consumer || disabledProjectFromMessage
    const projectDescription = project ? ` ${project}` : ''
    const activationUrl = new URL(
      'https://console.cloud.google.com/apis/library/iamcredentials.googleapis.com'
    )
    if (project) {
      activationUrl.searchParams.set('project', project)
    }
    return `Google IAM ${method} failed (${status}): IAM Service Account Credentials API is not enabled for OAuth client/quota project${projectDescription}. Enable it, wait a few minutes for the change to propagate, then retry: ${activationUrl.toString()}`
  }

  if (
    method === 'generateAccessToken' &&
    (/allowServiceAccountCredentialLifetimeExtension/.test(detail.message) ||
      /credential lifetime.*(?:exceeds|maximum|max allowed)/i.test(
        detail.message
      ))
  ) {
    return `Google IAM ${method} failed (${status}): Google rejected the requested service-account token lifetime above one hour. Add this service account to an organization policy for constraints/iam.allowServiceAccountCredentialLifetimeExtension, or omit accessTokenLifetimeSeconds to use the 3600-second default. ${detail.message}`
  }

  return `Google IAM ${method} failed (${status}): ${detail.message}`
}

function serviceAccountProjectId(serviceAccount: string): string | undefined {
  return serviceAccount.match(/@([^.]+)\.iam\.gserviceaccount\.com$/)?.[1]
}

function formatDriveCredentialError(
  status: number,
  detail: ParsedGoogleApiError,
  serviceAccount: string
): string {
  const service = detail.metadata?.service
  const isDriveApiDisabled =
    detail.reason === 'SERVICE_DISABLED' &&
    (!service || service === 'drive.googleapis.com')
  if (
    isDriveApiDisabled ||
    /Drive API.*(?:disabled|not been used)/i.test(detail.message)
  ) {
    const consumer = detail.metadata?.consumer?.replace(/^projects\//, '')
    const project = consumer || serviceAccountProjectId(serviceAccount)
    const projectDescription = project ? ` ${project}` : ''
    const activationUrl = new URL(
      'https://console.cloud.google.com/apis/library/drive.googleapis.com'
    )
    if (project) {
      activationUrl.searchParams.set('project', project)
    }
    return `Google Drive credential validation failed (${status}): Google Drive API is not enabled for service-account project${projectDescription}. Enable it, wait a few minutes for the change to propagate, then reconnect Drive: ${activationUrl.toString()}`
  }

  return `Google Drive credential validation failed (${status}): ${detail.message}`
}

/**
 * Verifies a newly minted service-account token against Drive before the app
 * publishes it as a syncing credential. IAM can mint a token even when the
 * Drive API is disabled for the service-account project.
 */
export async function validateImpersonatedGoogleDriveAccessToken(
  accessToken: string,
  serviceAccount: string
): Promise<void> {
  const response = await fetch(GOOGLE_DRIVE_ABOUT_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (response.ok) {
    return
  }
  const detail = await readGoogleApiError(response)
  throw new Error(
    formatDriveCredentialError(response.status, detail, serviceAccount)
  )
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
    throw new Error(formatIamCredentialsError(method, response.status, detail))
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
    const detail = await readGoogleApiError(response)
    throw new Error(
      `Google userinfo request failed (${response.status}): ${detail.message}`
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
