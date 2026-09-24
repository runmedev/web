// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpfsFilePayloadStorage } from './filePayloads'

afterEach(() => vi.unstubAllGlobals())

/** Model durable close separately from write so partial writes cannot appear committed. */
function filesystem() {
  const values = new Map<string, Blob>()
  const close = vi.fn(async () => {})
  const abort = vi.fn(async () => {})
  const getFileHandle = vi.fn(
    async (name: string, options?: { create?: boolean }) => {
      if (!options?.create && !values.has(name)) throw new Error('Not found')
      return {
        getFile: async () => values.get(name)!,
        createWritable: async () => {
          let pending = ''
          return {
            write: async (value: string) => {
              pending = value
            },
            close: async () => {
              await close()
              values.set(name, new Blob([pending]))
            },
            abort,
          }
        },
      }
    }
  )
  const directory = {
    getDirectoryHandle: async () => directory,
    getFileHandle,
    async *entries() {
      for (const name of values.keys()) yield [name, { kind: 'file' }] as const
    },
    removeEntry: async (name: string) => {
      values.delete(name)
    },
  }
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => directory },
  })
  return { values, close, abort }
}

describe('immutable OPFS file payloads', () => {
  it('collects obsolete generations on restart but protects durable and in-flight references', async () => {
    const { values } = filesystem()
    const previous = new OpfsFilePayloadStorage()
    const obsolete = await previous.write('superseded')
    const durable = await previous.write('current')
    const captured = await previous.write('captured by an async reader')
    const restarted = new OpfsFilePayloadStorage()
    restarted.protect(durable)
    const reading = restarted.read(captured)
    const writing = restarted.write('not yet committed to IndexedDB')
    await restarted.collectUnreferenced()
    const newRef = await writing
    expect(values.has(obsolete.path.split('/').at(-1)!)).toBe(false)
    await expect(reading).resolves.toBe('captured by an async reader')
    await expect(restarted.read(durable)).resolves.toBe('current')
    await expect(restarted.read(newRef)).resolves.toBe(
      'not yet committed to IndexedDB'
    )
  })

  it('preserves Unicode bytes and detects same-size corruption', async () => {
    const { values } = filesystem()
    const storage = new OpfsFilePayloadStorage()
    const content = 'Notebook ü 🐱'
    const ref = await storage.write(content)
    expect(ref.sizeBytes).toBe(new Blob([content]).size)
    await expect(storage.read(ref)).resolves.toBe(content)
    values.set(
      ref.path.split('/').at(-1)!,
      new Blob([content.replace('Notebook', 'Corrupt!')])
    )
    await expect(storage.read(ref)).rejects.toThrow('checksum mismatch')
  })

  it('never returns a reference when close fails', async () => {
    const { close, abort, values } = filesystem()
    close.mockRejectedValueOnce(new Error('Quota exceeded'))
    await expect(
      new OpfsFilePayloadStorage().write('original')
    ).rejects.toThrow('Quota exceeded')
    expect(abort).toHaveBeenCalledOnce()
    expect(values.size).toBe(0)
  })

  it('keeps an existing generation intact when the next write fails', async () => {
    const { close } = filesystem()
    const storage = new OpfsFilePayloadStorage()
    const original = await storage.write('original')
    close.mockRejectedValueOnce(new Error('Interrupted'))
    await expect(storage.write('replacement')).rejects.toThrow('Interrupted')
    await expect(storage.read(original)).resolves.toBe('original')
  })
})
