import type { Table } from 'dexie'

import type { DurableDriveCreateAttempt } from '../lib/driveTransfer'

const PREFIX = 'runme:drive-create-attempt:'
export interface CreationAttemptRecord {
  id: string
  requestId: string
  attempt: DurableDriveCreateAttempt
}

/** Capture old tab-owned retry identities before the worker can start Drive I/O. */
export function readLegacyCreationJournal(
  storage: Storage
): CreationAttemptRecord[] {
  const records: CreationAttemptRecord[] = []
  for (let i = 0; i < storage.length; i++) {
    const id = storage.key(i)
    if (!id?.startsWith(PREFIX)) continue
    const attempt = JSON.parse(storage.getItem(id) ?? 'null')
    if (
      !attempt ||
      typeof attempt.fileName !== 'string' ||
      typeof attempt.expectedChecksum !== 'string' ||
      typeof attempt.createdAtMs !== 'number' ||
      (attempt.remoteUri !== undefined &&
        typeof attempt.remoteUri !== 'string') ||
      (attempt.creationRevisionId !== undefined &&
        typeof attempt.creationRevisionId !== 'string')
    ) {
      throw new Error(
        'An unfinished Drive creation record is invalid. Preserve browser storage and repair it before retrying creation.'
      )
    }
    records.push({ id, requestId: id.slice(id.lastIndexOf(':') + 1), attempt })
  }
  return records
}

/** Import once without overwriting a newer worker attempt from another tab. */
export async function importLegacyCreationJournal(
  table: Table<CreationAttemptRecord, string>,
  records: CreationAttemptRecord[]
): Promise<void> {
  if (!records.length) return
  await table.db.transaction('rw', table, async () => {
    for (const record of records) {
      if (!record.id.startsWith(PREFIX))
        throw new Error('Invalid creation journal key')
      if (!(await table.get(record.id))) await table.put(record)
    }
  })
}
