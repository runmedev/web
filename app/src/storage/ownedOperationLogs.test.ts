// @vitest-environment node
import type { Table } from 'dexie'
import md5 from 'md5'
import { describe, expect, it, vi } from 'vitest'

import type { LocalFileRecord } from './local'
import { MemoryOperationLogStorage, operationLogPath } from './operationLogs'
import {
  type ContentGeneration,
  OwnedOperationLogs,
} from './ownedOperationLogs'

vi.mock('md5', async (importOriginal) => ({
  default: vi.fn((await importOriginal<{ default: typeof md5 }>()).default),
}))

function setup() {
  const uri = 'local://file/owner-test'
  let file = {
    id: uri,
    name: 'test.runme',
    remoteId: 'https://drive.google.com/file/d/test/view',
    doc: '',
    md5Checksum: 'old',
    lastRemoteChecksum: 'old',
    lastSynced: '',
  } as LocalFileRecord
  const generations = new Map<string, ContentGeneration>()
  const transaction = vi.fn(async (...args: unknown[]) =>
    (args.at(-1) as () => Promise<unknown>)()
  )
  const files = {
    db: { transaction },
    get: async () => ({ ...file }),
    update: async (_id: string, changes: Partial<LocalFileRecord>) => {
      file = { ...file, ...changes }
      return 1
    },
  } as unknown as Table<LocalFileRecord, string>
  const table = {
    get: async (path: string) => generations.get(path),
    put: async (value: ContentGeneration) => generations.set(value.path, value),
  } as unknown as Table<ContentGeneration, string>
  const storage = new MemoryOperationLogStorage()
  const owner = new OwnedOperationLogs(storage, files, table)
  return { uri, owner, storage, files, table, transaction, file: () => file }
}

describe('owned OPFS commits and sync acknowledgements', () => {
  it('does not hash local writes; computes once when reconciliation asks', async () => {
    const { owner, uri } = setup()
    vi.mocked(md5).mockClear()
    const initial = await owner.initialize(uri, 'A\n')
    await owner.append(initial.ref, 'B\n')
    const latest = await owner.read(initial.ref)
    expect(md5).not.toHaveBeenCalled()
    expect(latest.checksum).toBe(latest.checksum)
    expect(md5).toHaveBeenCalledTimes(1)
  })
  it('acknowledges A without clearing an edit B that arrived during upload', async () => {
    const { owner, uri, file } = setup()
    const captured = await owner.initialize(uri, 'A\n')
    await owner.append(captured.ref, 'B\n')
    expect(
      await owner.acknowledge(uri, captured, file().remoteId, {
        lastSyncError: undefined,
      })
    ).toBe(false)
    expect(file().lastRemoteChecksum).toBe(md5('A\n'))
    expect(file().md5Checksum).toBe('')
    const current = await owner.read(captured.ref)
    expect(await owner.acknowledge(uri, current, file().remoteId, {})).toBe(
      true
    )
    expect(file().md5Checksum).toBe(md5('A\nB\n'))
  })
  it('never writes OPFS when invalidation cannot commit', async () => {
    const { owner, uri, transaction, storage } = setup()
    const write = vi.spyOn(storage, 'initialize')
    transaction.mockRejectedValueOnce(new Error('quota'))
    await expect(owner.initialize(uri, 'A\n')).rejects.toThrow('quota')
    expect(write).not.toHaveBeenCalled()
  })
  it('keeps failed mutations pending across owner recreation', async () => {
    const { owner, uri, storage, files, table, file } = setup()
    const before = await owner.initialize(uri, 'A\n')
    await owner.acknowledge(uri, before, file().remoteId, {})
    vi.spyOn(storage, 'append').mockRejectedValueOnce(
      new Error('OPFS close failed')
    )
    await expect(owner.append(before.ref, 'B\n')).rejects.toThrow(
      'OPFS close failed'
    )
    expect(file().md5Checksum).toBe('')
    const restarted = new OwnedOperationLogs(storage, files, table)
    expect(await restarted.acknowledge(uri, before, file().remoteId, {})).toBe(
      false
    )
    const recovered = await restarted.read(before.ref)
    expect(recovered.document).toBe('A\n')
    expect(
      await restarted.acknowledge(uri, recovered, file().remoteId, {})
    ).toBe(true)
  })
  it('retains the exact first-write payload through failure and owner restart', async () => {
    const { owner, uri, storage, files, table, file } = setup()
    vi.spyOn(storage, 'initialize').mockRejectedValueOnce(
      new Error('close failed')
    )
    await expect(owner.initialize(uri, 'initial bytes\n')).rejects.toThrow(
      'close failed'
    )
    expect(file().pendingOperationLogInitialization).toBe('initial bytes\n')
    const restarted = new OwnedOperationLogs(storage, files, table)
    const recovered = await restarted.initialize(
      uri,
      file().pendingOperationLogInitialization!
    )
    expect(recovered.document).toBe('initial bytes\n')
    expect(file().pendingOperationLogInitialization).toBeUndefined()
    expect(file().md5Checksum).toBe('')
  })
  it('does not overwrite different existing bytes during initialization recovery', async () => {
    const { owner, uri, storage, file } = setup()
    const original = await storage.initialize(uri, 'original bytes\n')
    await expect(owner.initialize(uri, 'different bytes\n')).rejects.toThrow(
      'already exists'
    )
    expect((await storage.read(original.ref)).document).toBe('original bytes\n')
    expect(file().pendingOperationLogInitialization).toBe('different bytes\n')
  })
  it('serializes asynchronous mutations and snapshots for the same notebook', async () => {
    const { owner, uri } = setup()
    const initial = await owner.initialize(uri, 'A\n')
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = owner.appendTransaction(initial.ref, async () => {
      await blocked
      return 'B\n'
    })
    const second = owner.append(initial.ref, 'C\n')
    const snapshot = owner.read(initial.ref)
    release()
    await Promise.all([first, second])
    expect((await snapshot).document).toBe('A\nB\nC\n')
    expect((await snapshot).generation).toBe(3)
  })
  it('does not publish into a changed remote identity or erase a newer conflict', async () => {
    const { owner, uri, files, file } = setup()
    const before = await owner.initialize(uri, 'A\n')
    await owner.append(before.ref, 'B\n')
    await files.update(uri, { lastSyncError: 'new failure' })
    await owner.acknowledge(uri, before, file().remoteId, {
      lastSyncError: undefined,
    })
    expect(file().lastSyncError).toBe('new failure')
    expect(await owner.acknowledge(uri, before, 'different-remote', {})).toBe(
      false
    )
    expect(file().operationLogRef?.path).toBe(operationLogPath(uri))
  })
})
