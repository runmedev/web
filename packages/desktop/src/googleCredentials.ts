import type { GoogleTokenRequest, GoogleTokenResult } from './protocol.js'

const metadataUrl =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
const driveScopes = new Set([
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
])

export interface GoogleCredentialPolicy {
  serviceAccountEmail: string
  allowedScopes: string[]
}

/** Deployment policy is native process input, never a notebook-selected endpoint. */
export function googlePolicyFromEnv(
  env: NodeJS.ProcessEnv
): GoogleCredentialPolicy | undefined {
  if (!env.RUNME_GOOGLE_SERVICE_ACCOUNT) return undefined
  const policy = {
    serviceAccountEmail: env.RUNME_GOOGLE_SERVICE_ACCOUNT,
    allowedScopes: (
      env.RUNME_GOOGLE_SCOPES ?? 'https://www.googleapis.com/auth/drive'
    )
      .split(',')
      .map((s) => s.trim()),
  }
  if (
    !/^[\w.-]+@[\w.-]+\.iam\.gserviceaccount\.com$/.test(
      policy.serviceAccountEmail
    ) ||
    !policy.allowedScopes.length ||
    policy.allowedScopes.some((s) => !driveScopes.has(s))
  )
    throw new Error(
      'Invalid desktop Google service account or Drive scope policy'
    )
  return policy
}

/** JavaScript-only workload credentials. The metadata token never leaves the main process.
 * Fixed endpoints and a pinned account prevent turning preload into an arbitrary fetch proxy.
 */
export class GoogleCredentials {
  private cache = new Map<
    string,
    { result: GoogleTokenResult; refreshAt: number }
  >()
  private pending = new Map<string, Promise<GoogleTokenResult>>()

  constructor(
    private policy: GoogleCredentialPolicy | undefined,
    private request: typeof fetch = fetch,
    private now: () => number = Date.now
  ) {}

  async mint(input: GoogleTokenRequest): Promise<GoogleTokenResult> {
    const policy = this.policy
    if (!policy)
      throw new Error(
        'GKE Drive authentication is disabled in the desktop host'
      )
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some(
        (k) =>
          ![
            'expectedServiceAccountEmail',
            'scopes',
            'lifetimeSeconds',
            'forceRefresh',
          ].includes(k)
      ) ||
      input.expectedServiceAccountEmail !== policy.serviceAccountEmail ||
      !Array.isArray(input.scopes) ||
      input.scopes.length < 1 ||
      input.scopes.length > 3 ||
      input.scopes.some(
        (s) => !driveScopes.has(s) || !policy.allowedScopes.includes(s)
      ) ||
      (input.forceRefresh !== undefined &&
        typeof input.forceRefresh !== 'boolean')
    )
      throw new Error('Desktop Google identity or scopes are not allowed')
    const lifetime = input.lifetimeSeconds ?? 900
    if (!Number.isInteger(lifetime) || lifetime < 60 || lifetime > 3600)
      throw new Error('Invalid desktop Google token lifetime')
    const scopes = [...new Set(input.scopes)].sort()
    const key = JSON.stringify([scopes, lifetime])
    if (input.forceRefresh) this.cache.delete(key)
    const cached = this.cache.get(key)
    if (cached && cached.refreshAt > this.now())
      return structuredClone(cached.result)
    const pending = this.pending.get(key)
    if (pending) return structuredClone(await pending)
    if (this.pending.size >= 8)
      throw new Error('Too many concurrent Google credential requests')
    const work = this.exchange(scopes, lifetime)
      .then((result) => {
        if (this.cache.size >= 32)
          this.cache.delete(this.cache.keys().next().value!)
        const expiresAt = Date.parse(result.expiresAt)
        this.cache.set(key, {
          result,
          refreshAt: expiresAt - Math.min(120000, (expiresAt - this.now()) / 5),
        })
        return result
      })
      .finally(() => this.pending.delete(key))
    this.pending.set(key, work)
    return structuredClone(await work)
  }

  private async exchange(
    scopes: string[],
    lifetime: number
  ): Promise<GoogleTokenResult> {
    let stage = 'metadata'
    try {
      // Metadata can briefly be unavailable during GKE pod startup. Only retry transient failures.
      let metadata: Response | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        metadata = await this.request(metadataUrl, {
          headers: { 'Metadata-Flavor': 'Google' },
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        })
        if (metadata.ok || (metadata.status !== 429 && metadata.status < 500))
          break
        await metadata.body?.cancel()
        if (attempt < 2)
          await new Promise((resolve) =>
            setTimeout(resolve, 200 * (attempt + 1))
          )
      }
      if (!metadata?.ok) throw new Error('Metadata unavailable')
      const source = await metadata.json()
      if (
        typeof source.access_token !== 'string' ||
        !source.access_token ||
        source.token_type !== 'Bearer' ||
        !Number.isFinite(source.expires_in) ||
        source.expires_in <= 0
      )
        throw new Error('Invalid metadata credentials')
      stage = 'IAM Credentials'
      const response = await this.request(
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${this.policy!.serviceAccountEmail}:generateAccessToken`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
          headers: {
            Authorization: `Bearer ${source.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ scope: scopes, lifetime: `${lifetime}s` }),
        }
      )
      if (!response.ok) throw new Error('IAM request failed')
      const token = await response.json()
      const expiresAt = Date.parse(token.expireTime)
      if (
        typeof token.expireTime !== 'string' ||
        typeof token.accessToken !== 'string' ||
        !token.accessToken ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= this.now() + 5000 ||
        expiresAt > this.now() + (lifetime + 30) * 1000
      )
        throw new Error('Invalid IAM credentials')
      return {
        accessToken: token.accessToken,
        tokenType: 'Bearer',
        expiresAt: token.expireTime,
        serviceAccountEmail: this.policy!.serviceAccountEmail,
        scopes,
      }
    } catch {
      // Upstream bodies, URLs, and exception strings may include credentials: never reflect them.
      throw new Error(
        `GKE Drive ${stage} request failed; check workload identity, mint permission, and network access`
      )
    }
  }
}
