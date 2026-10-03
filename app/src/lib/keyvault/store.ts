/** Local encrypted vault. Only names and opaque references cross the notebook API. */
export const VAULT_STORAGE_KEY = 'runme/keyvault/v1'
const ITERATIONS = 600_000

type Envelope = { version: 1; salt: string; iv: string; ciphertext: string }
export type KeyReference = Readonly<{
  name: string
  toJSON(): { name: string }
}>
type Snapshot = Readonly<{
  status: 'new' | 'locked' | 'unlocked'
  names: readonly string[]
}>
const references = new WeakMap<
  KeyReference,
  { vault: KeyVault; name: string }
>()
const encode = (bytes: Uint8Array) => {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text)
}
const decode = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0))

/** Validate envelopes without discarding unreadable or unsupported saved data. */
function parseEnvelope(raw: string): Envelope {
  const value = JSON.parse(raw) as Envelope
  if (
    value.version !== 1 ||
    typeof value.salt !== 'string' ||
    typeof value.iv !== 'string' ||
    typeof value.ciphertext !== 'string' ||
    decode(value.salt).length !== 16 ||
    decode(value.iv).length !== 12
  ) {
    throw new Error('Unsupported or damaged vault.')
  }
  return value
}

/** React and notebook helpers share this tab-local store; plaintext is never persisted. */
export class KeyVault {
  private snapshot: Snapshot = Object.freeze({ status: 'locked', names: [] })
  private listeners = new Set<() => void>()
  private values = new Map<string, string>()
  private key?: CryptoKey
  private salt?: string
  private raw: string | null = null
  private generation = 0
  private busy = false

  constructor(private storage: () => Storage = () => window.localStorage) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot

  /** Called on panel mount and cross-tab storage changes; never overwrites ciphertext. */
  refresh = () => {
    const raw = this.storage().getItem(VAULT_STORAGE_KEY)
    if (raw !== this.raw || this.snapshot.status !== 'unlocked') {
      this.lock()
      this.raw = raw
      this.publish(raw === null ? 'new' : 'locked')
    }
  }

  private publish(status: Snapshot['status']) {
    this.snapshot = Object.freeze({
      status,
      names: Object.freeze([...this.values.keys()].sort()),
    })
    this.listeners.forEach((listener) => listener())
  }

  /** Invalidate in-flight unlocks/saves and immediately release decrypted values. */
  lock = () => {
    this.generation++
    this.key = undefined
    this.salt = undefined
    this.values.clear()
    this.publish(this.raw === null ? 'new' : 'locked')
  }

  private async derive(passphrase: string, salt: string) {
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    )
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: decode(salt),
        iterations: ITERATIONS,
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  }

  /** Serialize this tab's async edits. A storage comparison prevents stale tab writes. */
  private async exclusive(work: () => Promise<void>) {
    if (this.busy) throw new Error('A vault operation is already running.')
    this.busy = true
    try {
      // Web Locks coordinates writers in other tabs on this origin.
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request(VAULT_STORAGE_KEY, work)
      } else {
        await work()
      }
    } finally {
      this.busy = false
    }
  }

  private checkCurrent(raw: string | null, generation: number) {
    if (generation !== this.generation)
      throw new Error('Vault was locked. Unlock and retry.')
    if (this.storage().getItem(VAULT_STORAGE_KEY) !== raw) {
      this.refresh()
      throw new Error('Vault changed in another tab. Unlock it again.')
    }
  }

  /** Create or unlock using a passphrase retained only during key derivation. */
  async unlock(passphrase: string, create = false) {
    const generation = this.generation
    await this.exclusive(async () => {
      const raw = this.storage().getItem(VAULT_STORAGE_KEY)
      if (create && raw !== null)
        throw new Error('A vault already exists. Unlock it instead.')
      if (!create && raw === null) throw new Error('Create a vault first.')
      if (create && passphrase.length < 12)
        throw new Error('Use a passphrase of at least 12 characters.')
      let salt: string, key: CryptoKey, values: Map<string, string>
      try {
        const envelope = raw === null ? undefined : parseEnvelope(raw)
        salt =
          envelope?.salt ?? encode(crypto.getRandomValues(new Uint8Array(16)))
        key = await this.derive(passphrase, salt)
        const entries: unknown = envelope
          ? JSON.parse(
              new TextDecoder().decode(
                await crypto.subtle.decrypt(
                  { name: 'AES-GCM', iv: decode(envelope.iv) },
                  key,
                  decode(envelope.ciphertext)
                )
              )
            )
          : []
        if (
          !Array.isArray(entries) ||
          !entries.every(
            (e) =>
              Array.isArray(e) &&
              e.length === 2 &&
              typeof e[0] === 'string' &&
              typeof e[1] === 'string'
          )
        )
          throw new Error('Invalid entries')
        values = new Map(entries as [string, string][])
      } catch {
        throw new Error(
          'Unable to unlock vault. Check the passphrase; saved data has not been changed.'
        )
      }
      this.checkCurrent(raw, generation)
      let saved = raw
      if (create) saved = await this.persist(values, key, salt, raw, generation)
      this.checkCurrent(saved, generation)
      this.raw = saved
      this.key = key
      this.salt = salt
      this.values = values
      this.publish('unlocked')
    })
  }

  private async persist(
    values: Map<string, string>,
    key: CryptoKey,
    salt: string,
    raw: string | null,
    generation: number
  ) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify([...values]))
    )
    const saved = JSON.stringify({
      version: 1,
      salt,
      iv: encode(iv),
      ciphertext: encode(new Uint8Array(ciphertext)),
    })
    this.checkCurrent(raw, generation)
    try {
      this.storage().setItem(VAULT_STORAGE_KEY, saved)
    } catch {
      throw new Error(
        'Could not save the vault in this browser. Existing keys are unchanged.'
      )
    }
    return saved
  }

  /** Add a uniquely named key, or explicitly replace/rename an existing key. */
  async saveKey(name: string, value: string, previousName?: string) {
    name = name.trim()
    if (!name || name.length > 128)
      throw new Error('Use a key name between 1 and 128 characters.')
    if (!value.trim() && previousName === undefined)
      throw new Error('Enter a key value.')
    await this.mutate((values) => {
      if (previousName !== undefined && !values.has(previousName))
        throw new Error('Key no longer exists.')
      if (name !== previousName && values.has(name))
        throw new Error('That key name already exists.')
      const secret = value.trim() || values.get(previousName!)!
      if (previousName !== undefined) values.delete(previousName)
      values.set(name, secret)
    })
  }

  /** Remove a named key without exposing its value. */
  async deleteKey(name: string) {
    await this.mutate((values) => {
      values.delete(name)
    })
  }

  private async mutate(update: (values: Map<string, string>) => void) {
    await this.exclusive(async () => {
      if (!this.key || !this.salt)
        throw new Error('Unlock Key Vault in the left navigation first.')
      const generation = this.generation
      this.checkCurrent(this.raw, generation)
      const next = new Map(this.values)
      update(next)
      this.raw = await this.persist(
        next,
        this.key,
        this.salt,
        this.raw,
        generation
      )
      this.checkCurrent(this.raw, generation)
      this.values = next
      this.publish('unlocked')
    })
  }

  /** Return a harmless reference; logging/serializing it cannot reveal the credential. */
  getKey = (name: string): KeyReference => {
    this.requireValue(name)
    const reference = Object.freeze({ name, toJSON: () => ({ name }) })
    references.set(reference, { vault: this, name })
    return reference
  }

  /** Trusted transport/editor access checks lock state and deletion on every read. */
  requireValue(name: string): string {
    if (!this.key)
      throw new Error('Unlock Key Vault in the left navigation first.')
    this.checkCurrent(this.raw, this.generation)
    const value = this.values.get(name)
    if (!value)
      throw new Error(`Key "${name}" is missing. Add it in Key Vault.`)
    return value
  }
}

/** Only references created by this runtime are accepted; notebook JSON cannot forge one. */
export function resolveKeyReference(reference: KeyReference) {
  const entry = references.get(reference)
  if (!entry) throw new Error('Use keyvault.getKey(name) to select a key.')
  return entry.vault.requireValue(entry.name)
}

export const keyVault = new KeyVault()
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === VAULT_STORAGE_KEY || event.key === null)
      keyVault.refresh()
  })
  window.addEventListener('pagehide', () => keyVault.lock())
}

/** Browser notebook API deliberately excludes writes and raw secret retrieval. */
export const keyvaultApi = Object.freeze({
  getKey: keyVault.getKey,
  help: () =>
    'Add or unlock named keys in Key Vault (left navigation). Browser JS: agents.setKey(keyvault.getKey("openai-api")). getKey returns an opaque reference, not plaintext. Keys are encrypted locally and never synced with notebooks.',
})
