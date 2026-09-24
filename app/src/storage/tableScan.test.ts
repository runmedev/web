// @vitest-environment node
import type { Table } from 'dexie'
import { describe, expect, it, vi } from 'vitest'

import { readTablePage, scanTable, tableHasRecords } from './tableScan'

/** Expose only point reads and bounded key queries; bulk value APIs would fail. */
function fixture(count = 123) {
  const records = Array.from({ length: count }, (_, i) => ({
    id: String(i).padStart(3, '0'),
    doc: 'legacy payload',
  }))
  const keyLimits: number[] = []
  const query = (after?: string) => ({
    limit: (limit: number) => ({
      primaryKeys: async () => {
        keyLimits.push(limit)
        return records
          .map((record) => record.id)
          .filter((id) => after === undefined || id > after)
          .slice(0, limit)
      },
    }),
  })
  const get = vi.fn(async (id: string) =>
    records.find((record) => record.id === id)
  )
  const table = {
    get,
    toCollection: () => query(),
    where: () => ({ above: (after: string) => query(after) }),
  } as unknown as Table<(typeof records)[number], string>
  return { table, get, records, keyLimits }
}

describe('budgeted table reads', () => {
  it.each([undefined, 500, Infinity, NaN])(
    'caps a bulk page even for limit %s',
    async (limit) => {
      const { table, get, keyLimits } = fixture()
      const page = await readTablePage(table, (record) => ({ id: record.id }), {
        limit,
      })
      expect(page.rows).toHaveLength(50)
      expect(page.nextAfter).toBe('049')
      expect(get).toHaveBeenCalledTimes(50)
      expect(keyLimits).toEqual([51])
    }
  )

  it.each([0, -5, 1.9])(
    'normalizes small limits without an empty-page loop: %s',
    async (limit) => {
      const { table, get } = fixture()
      expect(
        (await readTablePage(table, (row) => row.id, { limit })).rows
      ).toEqual(['000'])
      expect(get).toHaveBeenCalledTimes(1)
    }
  )

  it('pages all IDs without skipping or duplicating them', async () => {
    const { table, records } = fixture()
    let after: string | undefined
    const ids: string[] = []
    do {
      const page = await readTablePage(table, (row) => row.id, { after })
      ids.push(...page.rows)
      after = page.nextAfter
    } while (after !== undefined)
    expect(ids).toEqual(records.map((row) => row.id))
  })

  it('bounds returned data and retries the overflow key on the next page', async () => {
    const { table, get } = fixture(3)
    const project = (row: { id: string }) => row.id + 'x'.repeat(100)
    const first = await readTablePage(table, project, {
      maxEstimatedBytes: 300,
    })
    expect(first.rows).toEqual([project({ id: '000' })])
    expect(first.nextAfter).toBe('000')
    expect(get).toHaveBeenCalledTimes(2)
    const second = await readTablePage(table, project, {
      after: first.nextAfter,
      maxEstimatedBytes: 300,
    })
    expect(second.rows).toEqual([project({ id: '001' })])
    expect(second.nextAfter).toBe('001')
  })

  it('projects a huge legacy body away before accumulating the page', async () => {
    const { table, records } = fixture(2)
    records[0].doc = 'x'.repeat(50 * 1024 * 1024)
    const page = await readTablePage(table, (row) => ({ id: row.id }))
    expect(page.rows).toEqual([{ id: '000' }, { id: '001' }])
    // Identity projection cannot accidentally restore a large payload array.
    await expect(
      readTablePage(table, (row) => row, { maxEstimatedBytes: Infinity })
    ).rejects.toThrow('exceeds metadata budget: 000')
  })

  it('does not let a larger requested byte budget bypass the hard cap', async () => {
    const { table } = fixture(1)
    await expect(
      readTablePage(table, () => 'x'.repeat(1024 * 1024), {
        maxEstimatedBytes: 99_000_000,
      })
    ).rejects.toThrow('exceeds metadata budget')
  })

  it('counts filtered and deleted records against the read cap while advancing the cursor', async () => {
    const { table, get } = fixture()
    get.mockResolvedValueOnce(undefined)
    const page = await readTablePage(table, () => undefined)
    expect(page).toEqual({ rows: [], nextAfter: '049' })
    expect(get).toHaveBeenCalledTimes(50)
  })

  it('streams without prefetching record bodies when a caller stops early', async () => {
    const { table, get, keyLimits } = fixture()
    for await (const record of scanTable(table)) {
      expect(record.id).toBe('000')
      break
    }
    expect(get).toHaveBeenCalledTimes(1)
    expect(keyLimits).toEqual([51])
  })

  it('streams each record once across key-window boundaries', async () => {
    const { table, records, keyLimits } = fixture()
    const ids: string[] = []
    for await (const row of scanTable(table)) ids.push(row.id)
    expect(ids).toEqual(records.map((row) => row.id))
    expect(keyLimits).toEqual([51, 51, 51])
  })

  it('rejects cyclic/non-data results instead of retaining opaque objects', async () => {
    const { table } = fixture(1)
    const cyclic: { next?: unknown } = {}
    cyclic.next = cyclic
    await expect(readTablePage(table, () => cyclic)).rejects.toThrow('cyclic')
    await expect(readTablePage(table, () => new Map())).rejects.toThrow(
      'plain metadata'
    )
  })

  it('checks table existence using one key and no record values', async () => {
    const { table, get, keyLimits } = fixture()
    await expect(tableHasRecords(table)).resolves.toBe(true)
    expect(get).not.toHaveBeenCalled()
    expect(keyLimits).toEqual([1])
    await expect(tableHasRecords(fixture(0).table)).resolves.toBe(false)
  })
})
