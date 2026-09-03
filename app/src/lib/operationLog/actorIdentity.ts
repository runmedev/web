import { getClaimedSessionId } from '../tabIdentity'

const ACTOR_STORAGE_PREFIX = 'runme/operation-log-actor'
const memoryActors = new Map<string, string>()

interface ActorStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function sessionStorageOrNull(): ActorStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function randomActorId(): string {
  const values = new Uint8Array(16)
  const crypto = globalThis.crypto
  if (!crypto?.getRandomValues) {
    throw new Error('Secure random actor identity generation is unavailable')
  }
  crypto.getRandomValues(values)
  return `actor_${[...values]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`
}

/** Allocates stable per-session, per-notebook operation-log actor identities. */
export class NotebookActorIdentity {
  constructor(
    private readonly sessionId: () => Promise<string>,
    private readonly storage: ActorStorage | null = sessionStorageOrNull()
  ) {}

  async get(canonicalUri: string): Promise<string> {
    if (!canonicalUri) {
      throw new Error('Notebook actor identity requires a canonical URI')
    }
    const sessionId = await this.sessionId()
    const key = `${ACTOR_STORAGE_PREFIX}/${encodeURIComponent(sessionId)}/${encodeURIComponent(canonicalUri)}`
    const existing = this.storage?.getItem(key) ?? memoryActors.get(key)
    if (existing) return existing

    const actorId = randomActorId()
    try {
      this.storage?.setItem(key, actorId)
    } catch {
      // The in-memory fallback still keeps the actor stable for this page.
    }
    memoryActors.set(key, actorId)
    return actorId
  }
}

const browserNotebookActorIdentity = new NotebookActorIdentity(
  getClaimedSessionId
)

export function getNotebookActorId(canonicalUri: string): Promise<string> {
  return browserNotebookActorIdentity.get(canonicalUri)
}
