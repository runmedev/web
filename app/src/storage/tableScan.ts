import type { Table } from 'dexie'

export const STORAGE_SCAN_BATCH_SIZE = 50
export const STORAGE_PAGE_MAX_ESTIMATED_BYTES = 1024 * 1024

export interface StoragePageOptions {
  after?: string
  limit?: number
  maxEstimatedBytes?: number
}

export interface StoragePage<T> {
  rows: T[]
  nextAfter?: string
}

/** Callers may lower a budget, but cannot raise or bypass the storage-wide cap. */
function capped(value: number | undefined, maximum: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(maximum, Math.floor(value!)))
    : maximum
}

/** Private key-only query: at most one page plus one lookahead key. */
async function readKeys<T>(
  table: Table<T, string>,
  after?: string,
  limit = STORAGE_SCAN_BATCH_SIZE + 1
): Promise<string[]> {
  const collection =
    after === undefined ? table.toCollection() : table.where(':id').above(after)
  return collection
    .limit(capped(limit, STORAGE_SCAN_BATCH_SIZE + 1))
    .primaryKeys()
}

/** Check for a next table without materializing even one record value. */
export async function tableHasRecords<T>(
  table: Table<T, string>
): Promise<boolean> {
  return (await readKeys(table, undefined, 1)).length !== 0
}

/**
 * Charge strings at two bytes per character and allow for object/property slots.
 * This is a data-size estimate, not a guarantee about engine heap overhead. Stop
 * at the budget without stringify/encoding copies of accidentally returned docs.
 * Bulk pages accept plain data only; cycles and non-data objects are rejected.
 */
function estimatedBytes(
  value: unknown,
  budget: number,
  ancestors = new Set<object>()
): number {
  if (typeof value === 'string') return 16 + value.length * 2
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return 8
  if (
    typeof value !== 'object' ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error('Storage pages require plain metadata values')
  }
  if (ancestors.has(value))
    throw new Error('Storage pages cannot contain cyclic metadata')
  ancestors.add(value)
  let bytes = 64
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      bytes += 16 + key.length * 2
      bytes += estimatedBytes(
        (value as Record<string, unknown>)[key],
        budget - bytes,
        ancestors
      )
      if (bytes > budget) break
    }
    return bytes
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Safe bulk API: project each source record before accumulating a bounded page.
 * Legacy records can still contain huge inline bodies, so never bulkGet them.
 * Projection may skip a row with undefined; skipped/deleted keys still consume
 * the read budget. Oversized projected rows fail visibly instead of being lost.
 */
export async function readTablePage<T, R>(
  table: Table<T, string>,
  project: (record: T) => R | undefined | Promise<R | undefined>,
  options: StoragePageOptions = {}
): Promise<StoragePage<R>> {
  const limit = capped(options.limit, STORAGE_SCAN_BATCH_SIZE)
  const budget = capped(
    options.maxEstimatedBytes,
    STORAGE_PAGE_MAX_ESTIMATED_BYTES
  )
  const keys = await readKeys(table, options.after, limit + 1)
  const rows: R[] = []
  let bytes = 0
  let after = options.after
  for (const key of keys.slice(0, limit)) {
    const record = await table.get(key)
    const row = record === undefined ? undefined : await project(record)
    if (row !== undefined) {
      const size = estimatedBytes(row, budget)
      if (size > budget)
        throw new Error(`Storage page row exceeds metadata budget: ${key}`)
      // Retry this key on the next page; it has not been included or skipped.
      if (bytes + size > budget) return { rows, nextAfter: after }
      rows.push(row)
      bytes += size
    }
    after = key
  }
  return { rows, nextAfter: keys.length > limit ? after : undefined }
}

/** Background discovery may visit all records, but retains one payload at a time. */
export async function* scanTable<T>(
  table: Table<T, string>
): AsyncGenerator<T> {
  let after: string | undefined
  for (;;) {
    const keys = await readKeys(table, after)
    if (!keys.length) return
    for (const key of keys.slice(0, STORAGE_SCAN_BATCH_SIZE)) {
      const record = await table.get(key)
      if (record !== undefined) yield record
    }
    after = keys[Math.min(keys.length, STORAGE_SCAN_BATCH_SIZE) - 1]
    if (keys.length <= STORAGE_SCAN_BATCH_SIZE) return
  }
}
