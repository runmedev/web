export const IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY =
  'runme/auth/impersonated-service-account/v1'

export const IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_CHANGED_EVENT =
  'runme-impersonated-service-account-credential-changed'

export type PersistedDriveServiceAccountCredential = {
  accessToken: string
  expiresAt: string
  scopes: string[]
}

export type PersistedAppServiceAccountCredential = {
  idToken: string
  expiresAt: string
  audience: string
}

export type PersistedImpersonatedServiceAccountCredential = {
  version: 1
  serviceAccount: string
  humanPrincipal: string
  createdAt: string
  authorizationLeaseExpiresAt: string
  drive?: PersistedDriveServiceAccountCredential
  app?: PersistedAppServiceAccountCredential
}

type CredentialTargets = Pick<
  PersistedImpersonatedServiceAccountCredential,
  'drive' | 'app'
>

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isUnexpired(value: string, nowMs: number): boolean {
  return Date.parse(value) > nowMs
}

function parseDriveCredential(
  value: unknown,
  nowMs: number
): PersistedDriveServiceAccountCredential | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as Partial<PersistedDriveServiceAccountCredential>
  if (
    typeof candidate.accessToken !== 'string' ||
    !candidate.accessToken.trim() ||
    !isValidDate(candidate.expiresAt) ||
    !isUnexpired(candidate.expiresAt, nowMs) ||
    !Array.isArray(candidate.scopes) ||
    !candidate.scopes.every((scope) => typeof scope === 'string')
  ) {
    return undefined
  }
  return {
    accessToken: candidate.accessToken,
    expiresAt: candidate.expiresAt,
    scopes: candidate.scopes.map((scope) => scope.trim()).filter(Boolean),
  }
}

function parseAppCredential(
  value: unknown,
  nowMs: number
): PersistedAppServiceAccountCredential | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as Partial<PersistedAppServiceAccountCredential>
  if (
    typeof candidate.idToken !== 'string' ||
    !candidate.idToken.trim() ||
    !isValidDate(candidate.expiresAt) ||
    !isUnexpired(candidate.expiresAt, nowMs) ||
    typeof candidate.audience !== 'string' ||
    !candidate.audience.trim()
  ) {
    return undefined
  }
  return {
    idToken: candidate.idToken,
    expiresAt: candidate.expiresAt,
    audience: candidate.audience.trim(),
  }
}

function parseCredential(
  value: unknown,
  nowMs: number
): PersistedImpersonatedServiceAccountCredential | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate =
    value as Partial<PersistedImpersonatedServiceAccountCredential>
  if (
    candidate.version !== 1 ||
    typeof candidate.serviceAccount !== 'string' ||
    !candidate.serviceAccount.trim() ||
    typeof candidate.humanPrincipal !== 'string' ||
    !candidate.humanPrincipal.trim() ||
    !isValidDate(candidate.createdAt) ||
    !isValidDate(candidate.authorizationLeaseExpiresAt) ||
    !isUnexpired(candidate.authorizationLeaseExpiresAt, nowMs)
  ) {
    return null
  }

  const drive = parseDriveCredential(candidate.drive, nowMs)
  const app = parseAppCredential(candidate.app, nowMs)
  if (!drive && !app) {
    return null
  }
  return {
    version: 1,
    serviceAccount: candidate.serviceAccount.trim(),
    humanPrincipal: candidate.humanPrincipal.trim(),
    createdAt: candidate.createdAt,
    authorizationLeaseExpiresAt: candidate.authorizationLeaseExpiresAt,
    ...(drive ? { drive } : {}),
    ...(app ? { app } : {}),
  }
}

function emitChange(): void {
  window.dispatchEvent(
    new Event(IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_CHANGED_EVENT)
  )
}

export function readImpersonatedServiceAccountCredential(
  nowMs = Date.now()
): PersistedImpersonatedServiceAccountCredential | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  try {
    const raw = window.localStorage.getItem(
      IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY
    )
    if (!raw) {
      return null
    }
    const parsed = parseCredential(JSON.parse(raw), nowMs)
    if (!parsed) {
      window.localStorage.removeItem(
        IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY
      )
      return null
    }

    const normalized = JSON.stringify(parsed)
    if (normalized !== raw) {
      window.localStorage.setItem(
        IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY,
        normalized
      )
    }
    return parsed
  } catch {
    window.localStorage.removeItem(
      IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY
    )
    return null
  }
}

export function saveImpersonatedServiceAccountCredential(
  credential: PersistedImpersonatedServiceAccountCredential
): PersistedImpersonatedServiceAccountCredential {
  const normalized = parseCredential(credential, Date.now())
  if (!normalized) {
    throw new Error(
      'Impersonated service-account credential is invalid or expired.'
    )
  }
  window.localStorage.setItem(
    IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY,
    JSON.stringify(normalized)
  )
  emitChange()
  return normalized
}

export function mergeImpersonatedServiceAccountCredential(input: {
  serviceAccount: string
  humanPrincipal: string
  authorizationLeaseExpiresAt: string
  drive?: PersistedDriveServiceAccountCredential
  app?: PersistedAppServiceAccountCredential
}): PersistedImpersonatedServiceAccountCredential {
  const serviceAccount = input.serviceAccount.trim()
  const humanPrincipal = input.humanPrincipal.trim()
  const existing = readImpersonatedServiceAccountCredential()
  const canMerge =
    existing?.serviceAccount.toLowerCase() === serviceAccount.toLowerCase() &&
    existing.humanPrincipal.toLowerCase() === humanPrincipal.toLowerCase()
  const targets: CredentialTargets = {
    ...(canMerge && existing?.drive ? { drive: existing.drive } : {}),
    ...(canMerge && existing?.app ? { app: existing.app } : {}),
    ...(input.drive ? { drive: input.drive } : {}),
    ...(input.app ? { app: input.app } : {}),
  }
  return saveImpersonatedServiceAccountCredential({
    version: 1,
    serviceAccount,
    humanPrincipal,
    createdAt: new Date().toISOString(),
    authorizationLeaseExpiresAt: input.authorizationLeaseExpiresAt,
    ...targets,
  })
}

export function clearImpersonatedServiceAccountCredential(
  targets?: Array<'drive' | 'app'>
): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  if (!targets || targets.length === 0) {
    window.localStorage.removeItem(
      IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY
    )
    emitChange()
    return
  }

  const existing = readImpersonatedServiceAccountCredential()
  if (!existing) {
    return
  }
  const removeTargets = new Set(targets)
  const drive = removeTargets.has('drive') ? undefined : existing.drive
  const app = removeTargets.has('app') ? undefined : existing.app
  if (!drive && !app) {
    window.localStorage.removeItem(
      IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY
    )
  } else {
    window.localStorage.setItem(
      IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY,
      JSON.stringify({ ...existing, drive, app })
    )
  }
  emitChange()
}
