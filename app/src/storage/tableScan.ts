import type { Table } from 'dexie'

export const STORAGE_SCAN_BATCH_SIZE = 50

/** Keyset pagination bounds key allocation and never bulk-loads record values. */
export async function tableKeyPage<T>(
  table: Table<T, string>,
  after?: string,
  limit = STORAGE_SCAN_BATCH_SIZE
): Promise<string[]> {
  const collection =
    after === undefined ? table.toCollection() : table.where(':id').above(after)
  return collection.limit(limit).primaryKeys()
}

/** Background discovery may visit all records, but retains one payload at a time. */
export async function* scanTable<T>(
  table: Table<T, string>
): AsyncGenerator<T> {
  let after: string | undefined
  for (;;) {
    const keys = await tableKeyPage(table, after)
    if (!keys.length) return
    for (const key of keys) {
      const record = await table.get(key)
      if (record !== undefined) yield record
    }
    after = keys[keys.length - 1]
    if (keys.length < STORAGE_SCAN_BATCH_SIZE) return
  }
}
