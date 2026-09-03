// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { NotebookActorIdentity } from './actorIdentity'

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('notebook actor identity', () => {
  it('is stable for one claimed session and notebook', async () => {
    const identity = new NotebookActorIdentity(
      async () => 'swift-river',
      new MemoryStorage()
    )
    const first = await identity.get('local://file/one')
    expect(await identity.get('local://file/one')).toBe(first)
    expect(first).toMatch(/^actor_[0-9a-f]{32}$/)
  })

  it('differs across notebooks and claimed sessions', async () => {
    const storage = new MemoryStorage()
    const firstSession = new NotebookActorIdentity(
      async () => 'swift-river',
      storage
    )
    const secondSession = new NotebookActorIdentity(
      async () => 'quiet-mesa',
      storage
    )

    const first = await firstSession.get('local://file/one')
    expect(await firstSession.get('local://file/two')).not.toBe(first)
    expect(await secondSession.get('local://file/one')).not.toBe(first)
  })
})
