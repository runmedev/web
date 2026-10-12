import { SignJWT, importPKCS8 } from 'jose'

export interface ConfigureRunnerAuthRequest {
  runnerName: string
  runnerBaseUrl: string
  issuer: string
  audience: string
  subject: string
  keyId: string
  privateKeyPkcs8Pem: string
}

export interface RunnerAuthStatus {
  runnerName: string
  runnerBaseUrl?: string
  configured: boolean
  issuer?: string
  audience?: string
  subject?: string
  keyId?: string
  tokenExpiresAt?: string
}

type Descriptor = Omit<ConfigureRunnerAuthRequest, 'privateKeyPkcs8Pem'>
type Entry = {
  descriptor: Descriptor
  key?: CryptoKey
  token?: string
  expiresAt?: number
  pending?: Promise<string>
}

const storageKey = 'runme/runnerAuthDescriptors/v1'
const entries = new Map<string, Entry>()
const configurationVersions = new Map<string, number>()
const listeners = new Set<() => void>()
let version = 0
let loaded = false

/** Normalize the destination before deciding which credential may be sent. */
export function runnerOrigin(endpoint: string): string {
  const url = new URL(endpoint)
  if (url.protocol === 'wss:') url.protocol = 'https:'
  if (url.protocol === 'ws:') url.protocol = 'http:'
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Invalid runner endpoint')
  return url.origin
}

function load() {
  if (loaded) return
  try {
    const saved: unknown = JSON.parse(
      sessionStorage.getItem(storageKey) ?? '[]'
    )
    if (!Array.isArray(saved)) throw new Error('Invalid saved descriptors')
    const descriptors = saved.map(descriptor)
    for (const d of descriptors) {
      entries.set(d.runnerName, { descriptor: d })
    }
    loaded = true
  } catch {
    // A damaged mode marker must not silently select saved human credentials.
    throw new Error('Saved runner authentication configuration is invalid')
  }
}

/** Validate a descriptor without including caller input in error messages. */
function descriptor(input: unknown): Descriptor {
  if (!input || typeof input !== 'object')
    throw new Error('Invalid runner auth configuration')
  const x = input as Record<string, unknown>
  const fields = [
    'runnerName',
    'runnerBaseUrl',
    'issuer',
    'audience',
    'subject',
    'keyId',
  ] as const
  for (const field of fields) {
    if (
      typeof x[field] !== 'string' ||
      !x[field].trim() ||
      x[field].length > 2048
    )
      throw new Error('Invalid runner auth configuration')
  }
  const d = Object.fromEntries(
    fields.map((field) => [field, x[field]])
  ) as unknown as Descriptor
  const url = new URL(d.runnerBaseUrl)
  if (
    url.protocol !== 'https:' ||
    url.origin !== d.runnerBaseUrl ||
    url.username ||
    url.password
  )
    throw new Error('Runner authentication requires an HTTPS origin')
  return d
}

function changed() {
  version++
  // Persist only the mode/identity marker, so reload fails closed until the key
  // is reimported instead of reverting to an unrelated saved human credential.
  sessionStorage.setItem(
    storageKey,
    JSON.stringify([...entries.values()].map((e) => e.descriptor))
  )
  listeners.forEach((listener) => listener())
}

/** Import a provisioned signing key into memory. Never return or persist it. */
export async function configureRunnerAuth(
  input: ConfigureRunnerAuthRequest
): Promise<RunnerAuthStatus> {
  load()
  const d = descriptor(input)
  const attempt = (configurationVersions.get(d.runnerName) ?? 0) + 1
  configurationVersions.set(d.runnerName, attempt)
  if (
    typeof input.privateKeyPkcs8Pem !== 'string' ||
    input.privateKeyPkcs8Pem.length > 16384
  )
    throw new Error('Invalid runner signing key')
  let key: CryptoKey
  try {
    key = await importPKCS8(input.privateKeyPkcs8Pem, 'ES256', {
      extractable: false,
    })
  } catch {
    throw new Error('Invalid ES256 runner signing key')
  }
  if (configurationVersions.get(d.runnerName) !== attempt)
    throw new Error('Runner authentication configuration was superseded')
  // A URL must not select credentials nondeterministically by registration order.
  for (const [name, e] of entries) {
    if (name !== d.runnerName && e.descriptor.runnerBaseUrl === d.runnerBaseUrl)
      throw new Error(
        'Runner origin already has an authentication configuration'
      )
  }
  entries.set(d.runnerName, { descriptor: d, key })
  changed()
  return getRunnerAuthStatus({ runnerName: d.runnerName })
}

/** Read redacted status; JWTs and private keys are intentionally excluded. */
export function getRunnerAuthStatus({
  runnerName,
}: {
  runnerName: string
}): RunnerAuthStatus {
  load()
  const e = entries.get(runnerName)
  return e
    ? {
        ...e.descriptor,
        configured: Boolean(e.key),
        tokenExpiresAt: e.expiresAt
          ? new Date(e.expiresAt).toISOString()
          : undefined,
      }
    : { runnerName, configured: false }
}

/** Clear in-memory authority but retain the marker that prevents human fallback. */
export function clearRunnerAuth({ runnerName }: { runnerName: string }): void {
  load()
  configurationVersions.set(
    runnerName,
    (configurationVersions.get(runnerName) ?? 0) + 1
  )
  const e = entries.get(runnerName)
  if (e) entries.set(runnerName, { descriptor: e.descriptor })
  changed()
}

/** Return one refresh-coalesced JWT shared by all APIs for this runner. */
export async function getRunnerIdToken(runnerName: string): Promise<string> {
  load()
  const e = entries.get(runnerName)
  if (!e?.key) throw new Error('Runner authentication needs key provisioning')
  if (e.token && (e.expiresAt ?? 0) > Date.now() + 60000) return e.token
  if (e.pending) return e.pending
  const now = Math.floor(Date.now() / 1000)
  const d = e.descriptor
  e.pending = new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: d.keyId })
    .setIssuer(d.issuer)
    .setAudience(d.audience)
    .setSubject(d.subject)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 300)
    .sign(e.key)
    .then((token) => {
      if (entries.get(runnerName) !== e)
        throw new Error('Runner authentication changed')
      e.token = token
      e.expiresAt = (now + 300) * 1000
      return token
    })
    .finally(() => {
      e.pending = undefined
    })
  return e.pending
}

/** Undefined means ordinary OIDC applies; a configured-but-cleared key throws. */
export async function getRunnerTokenForEndpoint(
  endpoint: string
): Promise<string | undefined> {
  load()
  const origin = runnerOrigin(endpoint)
  const entry = [...entries.values()].find(
    (e) => e.descriptor.runnerBaseUrl === origin
  )
  return entry ? getRunnerIdToken(entry.descriptor.runnerName) : undefined
}

export function hasRunnerAuthForEndpoint(endpoint: string): boolean {
  load()
  const origin = runnerOrigin(endpoint)
  return [...entries.values()].some(
    (e) => e.descriptor.runnerBaseUrl === origin
  )
}

export function subscribeRunnerAuth(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function getRunnerAuthVersion(): number {
  return version
}

export function listRunnerAuthStatus(): RunnerAuthStatus[] {
  load()
  return [...entries.keys()].map((runnerName) =>
    getRunnerAuthStatus({ runnerName })
  )
}

/** Reset module state for isolated tests; production uses configure/clear. */
export function resetRunnerAuthForTests(): void {
  entries.clear()
  configurationVersions.clear()
  loaded = false
  version++
}
