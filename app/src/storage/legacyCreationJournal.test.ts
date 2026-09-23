// @vitest-environment node
import type { Table } from 'dexie'
import { describe, expect, it, vi } from 'vitest'

import {
  type CreationAttemptRecord,
  importLegacyCreationJournal,
  readLegacyCreationJournal,
} from './legacyCreationJournal'

describe('legacy creation journal migration', () => {
  it('imports reserved IDs without overwriting a more recent worker record', async () => {
    const id = 'runme:drive-create-attempt:folder:operation'
    const attempt = {
      fileName: 'safe.runme',
      expectedChecksum: 'checksum',
      createdAtMs: 1,
      remoteUri: 'https://drive.google.com/file/d/reserved/view',
    }
    const storage = {
      length: 1,
      key: () => id,
      getItem: () => JSON.stringify(attempt),
    } as unknown as Storage
    const records = readLegacyCreationJournal(storage)
    const entries = new Map<string, CreationAttemptRecord>()
    const table = {
      db: {
        transaction: async (
          _mode: unknown,
          _table: unknown,
          fn: () => Promise<void>
        ) => fn(),
      },
      get: async (key: string) => entries.get(key),
      put: vi.fn(async (record: CreationAttemptRecord) => {
        entries.set(record.id, record)
      }),
    }
    await importLegacyCreationJournal(
      table as unknown as Table<CreationAttemptRecord, string>,
      records
    )
    expect(entries.get(id)?.attempt.remoteUri).toBe(attempt.remoteUri)
    await importLegacyCreationJournal(
      table as unknown as Table<CreationAttemptRecord, string>,
      records
    )
    expect(table.put).toHaveBeenCalledTimes(1)
  })
  it('fails visibly on corrupt retry identities rather than treating them as new attempts', () => {
    const storage = {
      length: 1,
      key: () => 'runme:drive-create-attempt:folder:op',
      getItem: () => '{}',
    } as unknown as Storage
    expect(() => readLegacyCreationJournal(storage)).toThrow(
      'unfinished Drive creation record'
    )
  })
})
