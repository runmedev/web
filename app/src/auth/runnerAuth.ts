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
  privateKeyPkcs8Pem?: string
  key?: CryptoKey
  token?: string
  expiresAt?: number
  pending?: Promise<string>
}

const legacyStorageKey = 'runme/runnerAuthDescriptors/v1'
const storageKey = 'runme/runnerAuth/v2'
const entries = new Map<string, Entry>()
const configurationVersions = new Map<string, number>()
const listeners = new Set<(runnerName: string) => void>()
let version = 0
let loaded = false
let savedRaw: string | null = null

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

/** Restore durable signers lazily. Reuse unchanged entries to preserve token coalescing. */
function load() {
  const wasLoaded = loaded
  try {
    const raw = localStorage.getItem(storageKey)
    if (loaded && raw === savedRaw) return
    const saved: unknown = JSON.parse(raw ?? '[]')
    const legacy: unknown = JSON.parse(
      sessionStorage.getItem(legacyStorageKey) ?? '[]'
    )
    if (!Array.isArray(saved) || !Array.isArray(legacy))
      throw new Error('Invalid saved configuration')
    const restored = new Map<string, Entry>()
    const origins = new Set<string>()
    for (const item of saved) {
      const d = descriptor(item)
      const pem = (item as Record<string, unknown>).privateKeyPkcs8Pem
      if (
        pem !== undefined &&
        (typeof pem !== 'string' || !pem || pem.length > 16384)
      )
        throw new Error('Invalid saved signing key')
      if (restored.has(d.runnerName) || origins.has(d.runnerBaseUrl))
        throw new Error('Duplicate runner configuration')
      origins.add(d.runnerBaseUrl)
      const old = entries.get(d.runnerName)
      restored.set(
        d.runnerName,
        old &&
          JSON.stringify(old.descriptor) === JSON.stringify(d) &&
          old.privateKeyPkcs8Pem === pem
          ? old
          : { descriptor: d, privateKeyPkcs8Pem: pem as string | undefined }
      )
    }
    // Another tab may already have durable credentials. Do not drop this tab's
    // older session-only bindings when adopting those records during migration.
    for (const item of legacy) {
      const d = descriptor(item)
      const current = restored.get(d.runnerName)
      if (current) {
        if (current.descriptor.runnerBaseUrl !== d.runnerBaseUrl)
          throw new Error('Runner origin changed')
      } else {
        if (origins.has(d.runnerBaseUrl))
          throw new Error('Duplicate runner configuration')
        origins.add(d.runnerBaseUrl)
        const old = entries.get(d.runnerName)
        restored.set(
          d.runnerName,
          old &&
            !old.privateKeyPkcs8Pem &&
            JSON.stringify(old.descriptor) === JSON.stringify(d)
            ? old
            : { descriptor: d }
        )
      }
    }
    // A removed credential still blocks fallback to unrelated human credentials.
    for (const [name, old] of entries) {
      if (!restored.has(name))
        restored.set(name, { descriptor: old.descriptor })
    }
    const changedNames = [...restored]
      .filter(([name, e]) => entries.get(name) !== e)
      .map(([name]) => name)
    entries.clear()
    restored.forEach((entry, name) => entries.set(name, entry))
    savedRaw = raw
    loaded = true
    for (const name of changedNames) {
      configurationVersions.set(
        name,
        (configurationVersions.get(name) ?? 0) + 1
      )
      if (wasLoaded) changed(name)
    }
  } catch {
    // Corrupt saved credentials must never select unrelated human authentication.
    throw new Error('Saved runner authentication configuration is invalid')
  }
}

/** Persist only provisioned configuration; minted JWTs remain in memory. */
function persist(next: Map<string, Entry>) {
  const raw = JSON.stringify(
    [...next.values()].map((e) => ({
      ...e.descriptor,
      privateKeyPkcs8Pem: e.privateKeyPkcs8Pem,
    }))
  )
  try {
    localStorage.setItem(storageKey, raw)
  } catch {
    throw new Error('Unable to save runner authentication configuration')
  }
  savedRaw = raw
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
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$/.test(url.hostname)
  if (
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
    url.origin !== d.runnerBaseUrl ||
    url.username ||
    url.password
  )
    throw new Error(
      'Runner authentication requires an HTTPS origin or HTTP loopback origin'
    )
  return d
}

/** Notify token consumers after any change to this runner's authority. */
function changed(runnerName: string) {
  version++
  listeners.forEach((listener) => listener(runnerName))
}

// Other tabs share the provisioned key, but never cached runner or Google tokens.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (
      event.storageArea !== localStorage ||
      (event.key !== storageKey && event.key !== null)
    )
      return
    try {
      load()
    } catch {
      // Invalidate cached downstream tokens even when the new record is corrupt.
      for (const name of entries.keys()) changed(name)
    }
  })

/** Import and persist a provisioned key. Status and notebook APIs never return it. */
export async function configureRunnerAuth(
  input: ConfigureRunnerAuthRequest
): Promise<RunnerAuthStatus> {
  load()
  const d = descriptor(input)
  const previous = entries.get(d.runnerName)
  if (previous && previous.descriptor.runnerBaseUrl !== d.runnerBaseUrl)
    throw new Error('Use a new runner name when changing its origin')
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
  load()
  if (configurationVersions.get(d.runnerName) !== attempt)
    throw new Error('Runner authentication configuration was superseded')
  // A URL must not select credentials nondeterministically by registration order.
  for (const [name, e] of entries) {
    if (name !== d.runnerName && e.descriptor.runnerBaseUrl === d.runnerBaseUrl)
      throw new Error(
        'Runner origin already has an authentication configuration'
      )
  }
  const entry = {
    descriptor: d,
    key,
    privateKeyPkcs8Pem: input.privateKeyPkcs8Pem,
  }
  const next = new Map(entries).set(d.runnerName, entry)
  persist(next)
  entries.set(d.runnerName, entry)
  changed(d.runnerName)
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
        configured: Boolean(e.key || e.privateKeyPkcs8Pem),
        tokenExpiresAt: e.expiresAt
          ? new Date(e.expiresAt).toISOString()
          : undefined,
      }
    : { runnerName, configured: false }
}

/** Remove the durable key and cached tokens; retain the no-human-fallback marker. */
export function clearRunnerAuth({ runnerName }: { runnerName: string }): void {
  load()
  configurationVersions.set(
    runnerName,
    (configurationVersions.get(runnerName) ?? 0) + 1
  )
  const e = entries.get(runnerName)
  if (e) entries.set(runnerName, { descriptor: e.descriptor })
  try {
    persist(entries)
  } finally {
    // Revoke cached authority even if persistence fails. The caller sees the failure.
    changed(runnerName)
  }
}

/** Return one refresh-coalesced JWT shared by all APIs for this runner. */
export async function getRunnerIdToken(runnerName: string): Promise<string> {
  load()
  const e = entries.get(runnerName)
  if (!e || (!e.key && !e.privateKeyPkcs8Pem))
    throw new Error('Runner authentication needs key provisioning')
  if (e.token && (e.expiresAt ?? 0) > Date.now() + 60000) return e.token
  if (e.pending) return e.pending
  const now = Math.floor(Date.now() / 1000)
  const d = e.descriptor
  e.pending = (async () => {
    if (!e.key) {
      try {
        e.key = await importPKCS8(e.privateKeyPkcs8Pem!, 'ES256', {
          extractable: false,
        })
      } catch {
        throw new Error('Invalid ES256 runner signing key; provision it again')
      }
    }
    load()
    if (entries.get(runnerName) !== e)
      throw new Error('Runner authentication changed')
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: d.keyId })
      .setIssuer(d.issuer)
      .setAudience(d.audience)
      .setSubject(d.subject)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 300)
      .sign(e.key)
  })()
    .then((token) => {
      load()
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

export function subscribeRunnerAuth(
  listener: (runnerName: string) => void
): () => void {
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
  savedRaw = null
  version++
}
