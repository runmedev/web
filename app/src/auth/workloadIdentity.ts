import type {
  DesktopBridge,
  GoogleTokenMode,
} from '../../../packages/desktop/src/protocol'
import {
  getRunnerAuthStatus,
  getRunnerIdToken,
  subscribeRunnerAuth,
} from './runnerAuth'

export interface WorkloadIdentityDriveConfig {
  authFlow: 'workload_identity'
  provider?: 'runner' | 'gke_metadata'
  tokenMode?: GoogleTokenMode
  runnerName?: string
  expectedServiceAccountEmail: string
  scopes: string[]
  lifetimeSeconds?: number
}

type Token = { accessToken: string; expiresAt: number; refreshAt: number }
const storageKey = 'runme/workloadIdentityDrive/v1'
let config: WorkloadIdentityDriveConfig | undefined
let loaded = false
let token: Token | undefined
let pending: Promise<string> | undefined
let generation = 0
let version = 0
let lastError: string | null = null
let suspended = false
const listeners = new Set<() => void>()

function emit() {
  version++
  listeners.forEach((listener) => listener())
}
function invalidate() {
  generation++
  token = undefined
  pending = undefined
  emit()
}
subscribeRunnerAuth((runnerName) => {
  if (getWorkloadIdentityConfig()?.runnerName === runnerName) invalidate()
})

function normalize(
  input: WorkloadIdentityDriveConfig
): WorkloadIdentityDriveConfig {
  if (
    !input ||
    input.authFlow !== 'workload_identity' ||
    (input.provider !== undefined &&
      !['runner', 'gke_metadata'].includes(input.provider)) ||
    (input.provider !== 'gke_metadata' &&
      (typeof input.runnerName !== 'string' || !input.runnerName.trim())) ||
    typeof input.expectedServiceAccountEmail !== 'string' ||
    !/^[\w.-]+@[\w.-]+\.iam\.gserviceaccount\.com$/.test(
      input.expectedServiceAccountEmail
    ) ||
    !Array.isArray(input.scopes) ||
    input.scopes.length === 0 ||
    input.scopes.length > 32 ||
    input.scopes.some(
      (s) =>
        typeof s !== 'string' ||
        !s.startsWith('https://www.googleapis.com/auth/') ||
        /\s/.test(s)
    )
  )
    throw new Error('Invalid workload identity Drive configuration')
  if (
    input.tokenMode !== undefined &&
    (input.provider !== 'gke_metadata' ||
      !['iam_exchange', 'metadata_direct'].includes(input.tokenMode))
  )
    throw new Error('Invalid GKE metadata token mode')
  if (
    input.tokenMode === 'metadata_direct' &&
    input.lifetimeSeconds !== undefined
  )
    throw new Error(
      'lifetimeSeconds is not supported in metadata_direct mode; metadata controls expiry'
    )
  const lifetime = input.lifetimeSeconds ?? 900
  if (!Number.isInteger(lifetime) || lifetime < 60 || lifetime > 3600)
    throw new Error('Invalid token lifetime')
  return {
    authFlow: 'workload_identity',
    ...(input.provider === 'gke_metadata'
      ? {
          provider: 'gke_metadata' as const,
          ...(input.tokenMode ? { tokenMode: input.tokenMode } : {}),
        }
      : { runnerName: input.runnerName }),
    expectedServiceAccountEmail: input.expectedServiceAccountEmail,
    scopes: [...new Set(input.scopes)].sort(),
    ...(input.tokenMode === 'metadata_direct'
      ? {}
      : { lifetimeSeconds: lifetime }),
  }
}

/** Restore only nonsecret mode selection, never Google or runner credentials. */
export function getWorkloadIdentityConfig():
  | WorkloadIdentityDriveConfig
  | undefined {
  if (!loaded) {
    const raw = sessionStorage.getItem(storageKey)
    if (raw) config = normalize(JSON.parse(raw))
    loaded = true
  }
  return config ? { ...config, scopes: [...config.scopes] } : undefined
}

/** Select unattended Drive auth. Persisting the mode makes reload fail closed. */
export function configureGoogleWorkloadIdentity(
  input: WorkloadIdentityDriveConfig
): void {
  const next = normalize(input)
  sessionStorage.setItem(storageKey, JSON.stringify(next))
  config = next
  loaded = true
  lastError = null
  suspended = false
  invalidate()
}

/** The isolated preload is the only desktop credential transport; web mode has no fallback. */
function desktopGoogle() {
  return (window as Window & { runmeDesktop?: DesktopBridge }).runmeDesktop
    ?.googleAccessToken
}

export const desktopRequiredError =
  'GKE metadata provider requires Runme Desktop'

/** Obtain requested Google scopes through the selected workload provider. */
export function getWorkloadIdentityAccessToken(
  forceRefresh = false
): Promise<string> {
  const cfg = getWorkloadIdentityConfig()
  if (!cfg)
    return Promise.reject(new Error('Workload identity is not configured'))
  if (suspended)
    return Promise.reject(new Error('Workload identity sync is disconnected'))
  if (cfg.provider === 'gke_metadata' && !desktopGoogle())
    return Promise.reject(new Error(desktopRequiredError))
  if (forceRefresh) token = undefined
  if (token && token.refreshAt > Date.now())
    return Promise.resolve(token.accessToken)
  if (pending) return pending
  const currentGeneration = generation
  const work = (async () => {
    const requestGeneration = currentGeneration
    const result =
      cfg.provider === 'gke_metadata'
        ? await (() => {
            const mint = desktopGoogle()
            if (!mint) throw new Error(desktopRequiredError)
            return mint({
              tokenMode: cfg.tokenMode,
              expectedServiceAccountEmail: cfg.expectedServiceAccountEmail,
              scopes: cfg.scopes,
              lifetimeSeconds: cfg.lifetimeSeconds,
              forceRefresh,
            })
          })()
        : await (async () => {
            const status = getRunnerAuthStatus({ runnerName: cfg.runnerName! })
            if (!status.runnerBaseUrl)
              throw new Error('Runner authentication needs key provisioning')
            const jwt = await getRunnerIdToken(cfg.runnerName!)
            if (generation !== currentGeneration)
              throw new Error('Workload identity configuration changed')
            const response = await fetch(
              `${status.runnerBaseUrl}/v1/credentials/google:mint`,
              {
                method: 'POST',
                credentials: 'omit',
                redirect: 'error',
                signal: AbortSignal.timeout(20000),
                headers: {
                  Authorization: `Bearer ${jwt}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  scopes: cfg.scopes,
                  lifetimeSeconds: cfg.lifetimeSeconds,
                }),
              }
            )
            if (!response.ok)
              throw new Error(
                response.status === 401
                  ? 'Runner authentication needs key provisioning'
                  : response.status === 403
                    ? 'Runner denied Google token creation or requested scopes'
                    : 'Runner Google token service unavailable'
              )
            return response.json()
          })()
    const expiresAt = Date.parse(result.expiresAt)
    if (
      result.tokenType !== 'Bearer' ||
      typeof result.accessToken !== 'string' ||
      !result.accessToken ||
      result.serviceAccountEmail !== cfg.expectedServiceAccountEmail ||
      !Array.isArray(result.scopes) ||
      JSON.stringify([...new Set(result.scopes)].sort()) !==
        JSON.stringify(cfg.scopes) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() + 5000 ||
      (cfg.tokenMode !== 'metadata_direct' &&
        expiresAt > Date.now() + (cfg.lifetimeSeconds! + 30) * 1000)
    )
      throw new Error(
        'Workload provider returned unexpected Google credentials'
      )
    if (
      requestGeneration !== generation ||
      JSON.stringify(getWorkloadIdentityConfig()) !== JSON.stringify(cfg)
    )
      throw new Error('Workload identity configuration changed')
    const remaining = expiresAt - Date.now()
    token = {
      accessToken: result.accessToken,
      expiresAt,
      refreshAt: expiresAt - Math.min(120000, remaining / 5),
    }
    lastError = null
    emit()
    return token.accessToken
  })()
    .catch(() => {
      // Do not reflect arbitrary fetch/JSON/crypto errors (which can contain input).
      if (currentGeneration === generation) {
        lastError = 'Unable to obtain workload identity credentials'
        emit()
      }
      throw new Error(
        'Unable to obtain workload identity credentials; check the selected provider, identity, scopes, and availability'
      )
    })
    .finally(() => {
      if (pending === work) pending = undefined
    })
  pending = work
  return work
}

/** This status is safe for React and WebMCP: no raw credentials are returned. */
export function getWorkloadIdentityStatus() {
  const cfg = getWorkloadIdentityConfig()
  return cfg
    ? {
        connected: Boolean(token && token.expiresAt > Date.now()),
        // Sync availability describes the renewable source, not a cached token.
        // Otherwise an idle expired token disables the only queue that can renew it.
        canRenew:
          !suspended &&
          (cfg.provider === 'gke_metadata'
            ? Boolean(desktopGoogle())
            : getRunnerAuthStatus({ runnerName: cfg.runnerName! }).configured),
        authFlow: 'workload_identity' as const,
        effectivePrincipal: cfg.expectedServiceAccountEmail,
        authorizingPrincipal:
          cfg.provider === 'gke_metadata' ? 'GKE workload identity' : 'runme',
        expiresAt: token ? new Date(token.expiresAt).toISOString() : null,
        renewal: 'workload_identity' as const,
        lastError,
      }
    : undefined
}
export function subscribeWorkloadIdentity(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function getWorkloadIdentityVersion(): number {
  return version
}

/** Drop cached Google credentials while retaining the selected auth mode. */
export function clearWorkloadIdentityToken(): void {
  suspended = true
  invalidate()
}

export function resetWorkloadIdentityForTests(): void {
  config = undefined
  loaded = false
  lastError = null
  suspended = false
  invalidate()
}
