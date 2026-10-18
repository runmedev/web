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
  if (env.RUNME_GOOGLE_TOKEN_MODE !== undefined)
    throw new Error(
      'Remove RUNME_GOOGLE_TOKEN_MODE; GKE metadata authentication is direct-only'
    )
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

/** JavaScript-only workload credentials. Only the selected scoped token reaches the renderer.
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
          !['expectedServiceAccountEmail', 'scopes', 'forceRefresh'].includes(k)
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
    const scopes = [...new Set(input.scopes)].sort()
    const key = JSON.stringify(scopes)
    if (input.forceRefresh) this.cache.delete(key)
    const cached = this.cache.get(key)
    if (cached && cached.refreshAt > this.now())
      return structuredClone(cached.result)
    const pending = this.pending.get(key)
    if (pending) return structuredClone(await pending)
    if (this.pending.size >= 8)
      throw new Error('Too many concurrent Google credential requests')
    const work = this.acquireToken(scopes)
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

  /** Fixed metadata requests stay in the main process and never follow redirects. */
  private async metadata(url: string): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.request(url, {
        headers: { 'Metadata-Flavor': 'Google' },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) return response
      await response.body?.cancel()
      if ((response.status !== 429 && response.status < 500) || attempt === 2)
        throw new Error('Metadata unavailable')
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
    throw new Error('Metadata unavailable')
  }

  /** Verify the pod identity before acquiring its scoped token. No impersonation or fallback. */
  private async acquireToken(scopes: string[]): Promise<GoogleTokenResult> {
    let stage = 'metadata identity'
    try {
      const email = await this.metadata(metadataUrl.replace(/token$/, 'email'))
      if ((await email.text()).trim() !== this.policy!.serviceAccountEmail)
        throw new Error('Unexpected metadata identity')
      const url = new URL(metadataUrl)
      url.searchParams.set('scopes', scopes.join(','))
      stage = 'metadata token'
      // Measure from request start so network latency never extends the token's lifetime.
      const requestedAt = this.now()
      const metadata = await this.metadata(url.toString())
      const source = await metadata.json()
      if (
        typeof source.access_token !== 'string' ||
        !source.access_token ||
        source.token_type !== 'Bearer' ||
        !Number.isFinite(source.expires_in) ||
        source.expires_in <= 0
      )
        throw new Error('Invalid metadata credentials')
      const expiresAt = requestedAt + source.expires_in * 1000
      if (
        !Number.isSafeInteger(source.expires_in) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= this.now() + 5000
      )
        throw new Error('Invalid metadata expiry')
      return {
        accessToken: source.access_token,
        tokenType: 'Bearer',
        expiresAt: new Date(expiresAt).toISOString(),
        serviceAccountEmail: this.policy!.serviceAccountEmail,
        scopes,
      }
    } catch {
      // Upstream bodies, URLs, and exception strings may include credentials: never reflect them.
      throw new Error(
        `GKE Drive ${stage} request failed; check workload identity, configured identity/scopes, and network access`
      )
    }
  }
}
