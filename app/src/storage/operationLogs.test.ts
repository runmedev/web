/// <reference types="vitest" />
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MemoryOperationLogStorage,
  type OperationLogCoordinator,
  OpfsOperationLogStorage,
  operationLogPath,
} from './operationLogs'

function coordinator(): OperationLogCoordinator {
  const tails = new Map<string, Promise<void>>()
  return {
    async runExclusive<T>(
      path: string,
      operation: () => Promise<T>
    ): Promise<T> {
      const previous = tails.get(path) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      const tail = previous.then(() => current)
      tails.set(path, tail)
      await previous
      try {
        return await operation()
      } finally {
        release()
        if (tails.get(path) === tail) tails.delete(path)
      }
    },
  }
}

describe('operation-log storage', () => {
  it('uses one deterministic OPFS path per canonical notebook URI', () => {
    expect(operationLogPath('local://file/notebook 1')).toBe(
      'runme/notebooks/local%3A%2F%2Ffile%2Fnotebook%201/document.runme'
    )
  })

  it('initializes, appends, replaces, and deletes a framed log', async () => {
    const storage = new MemoryOperationLogStorage()
    const initial = await storage.initialize(
      'local://file/one',
      '{"header":1}\n'
    )
    const appended = await storage.append(initial.ref, '{"op":1}\n')
    expect(appended.document).toBe('{"header":1}\n{"op":1}\n')
    expect(appended.sizeBytes).toBeGreaterThan(initial.sizeBytes)
    expect(appended.checksum).not.toBe(initial.checksum)

    const replaced = await storage.replace(initial.ref, '{"compacted":true}\n')
    expect(replaced.document).toBe('{"compacted":true}\n')
    await storage.delete(initial.ref)
    await expect(storage.read(initial.ref)).rejects.toThrow(
      'Operation log not found'
    )
  })

  it('rejects unframed or blank records', async () => {
    const storage = new MemoryOperationLogStorage()
    await expect(storage.initialize('local://file/one', '{}')).rejects.toThrow(
      'end with LF'
    )
    const initial = await storage.initialize('local://file/one', '{}\n')
    await expect(storage.append(initial.ref, '\n')).rejects.toThrow(
      'blank records'
    )
  })

  it('does not lose concurrent appends from separate storage clients', async () => {
    const documents = new Map<string, string>()
    const sharedCoordinator = coordinator()
    const first = new MemoryOperationLogStorage(documents, sharedCoordinator)
    const second = new MemoryOperationLogStorage(documents, sharedCoordinator)
    const initial = await first.initialize(
      'local://file/shared',
      '{"header":1}\n'
    )

    await Promise.all([
      first.append(initial.ref, '{"actor":"alice"}\n'),
      second.append(initial.ref, '{"actor":"bob"}\n'),
    ])

    const lines = (await first.read(initial.ref)).document.trim().split('\n')
    expect(lines[0]).toBe('{"header":1}')
    expect(new Set(lines.slice(1))).toEqual(
      new Set(['{"actor":"alice"}', '{"actor":"bob"}'])
    )
  })

  it('rejects a stale compare-and-swap replacement', async () => {
    const storage = new MemoryOperationLogStorage()
    const initial = await storage.initialize('local://file/cas', '{}\n')
    await storage.append(initial.ref, '{"new":true}\n')
    await expect(
      storage.replace(initial.ref, '{"stale":true}\n', {
        expectedChecksum: initial.checksum,
      })
    ).rejects.toThrow('changed before replacement')
  })
})

describe.each(['memory', 'opfs'])(
  'atomic upgrades in %s storage',
  (backend) => {
    afterEach(() => vi.unstubAllGlobals())

    function storage() {
      if (backend === 'memory') return new MemoryOperationLogStorage()
      // Model OPFS close-to-commit semantics, including keepExistingData and seek.
      let committed = ''
      const handle = {
        getFile: async () => ({
          size: new TextEncoder().encode(committed).length,
          text: async () => committed,
        }),
        createWritable: async (options?: { keepExistingData?: boolean }) => {
          let pending = options?.keepExistingData ? committed : ''
          let offset = 0
          return {
            seek: async (position: number) => {
              offset = position
            },
            write: async (value: string) => {
              pending = pending.slice(0, offset) + value
            },
            close: async () => {
              committed = pending
            },
          }
        },
      }
      const directory = {
        getDirectoryHandle: async () => directory,
        getFileHandle: async () => handle,
      }
      vi.stubGlobal('navigator', {
        storage: { getDirectory: async () => directory },
      })
      return new OpfsOperationLogStorage(coordinator())
    }

    const prepareDocument = (document: string) =>
      document.replace('"version":1', '"version":2')

    it('upgrades and appends under one lock, retaining concurrent writers', async () => {
      const s = storage()
      const initial = await s.initialize(
        'local://file/upgrade',
        '{"version":1}\n'
      )
      await Promise.all([
        s.appendTransaction(
          initial.ref,
          (current) => {
            expect(current).toContain('"version":2')
            return '{"a":1}\n'
          },
          { prepareDocument }
        ),
        s.append(initial.ref, '{"b":1}\n', { prepareDocument }),
      ])
      expect((await s.read(initial.ref)).document).toBe(
        '{"version":2}\n{"a":1}\n{"b":1}\n'
      )
    })

    it('commits a header-only upgrade idempotently', async () => {
      const s = storage()
      const initial = await s.initialize(
        'local://file/upgrade',
        '{"version":1}\n'
      )
      const first = await s.appendTransaction(initial.ref, () => '', {
        prepareDocument,
      })
      const second = await s.appendTransaction(initial.ref, () => '', {
        prepareDocument,
      })
      expect(first.document).toBe('{"version":2}\n')
      expect(second).toEqual(first)
    })

    it('does not commit the header when record creation or validation fails', async () => {
      const s = storage()
      const initial = await s.initialize(
        'local://file/upgrade',
        '{"version":1}\n'
      )
      await expect(
        s.appendTransaction(
          initial.ref,
          () => {
            throw new Error('invalid record')
          },
          { prepareDocument }
        )
      ).rejects.toThrow('invalid record')
      await expect(
        s.append(initial.ref, '{"bad":1}\n', {
          prepareDocument,
          validate: () => {
            throw new Error('invalid log')
          },
        })
      ).rejects.toThrow('invalid log')
      expect(await s.read(initial.ref)).toEqual(initial)
    })
  }
)
