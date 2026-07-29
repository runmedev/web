/// <reference types="vitest" />
// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { MemoryIpynbShadowStorage } from './ipynbShadows'

describe('MemoryIpynbShadowStorage', () => {
  it('stores content-addressed shadows and verifies their integrity', async () => {
    const storage = new MemoryIpynbShadowStorage()
    const first = await storage.write('local://file/a', '{"nbformat":4}')
    const duplicate = await storage.write('local://file/a', '{"nbformat":4}')
    const changed = await storage.write(
      'local://file/a',
      '{"nbformat":4,"cells":[]}'
    )

    expect(duplicate.path).toBe(first.path)
    expect(changed.path).not.toBe(first.path)
    await expect(storage.read(first)).resolves.toBe('{"nbformat":4}')

    await storage.delete(first)
    await expect(storage.read(first)).rejects.toThrow('shadow not found')
  })
})
