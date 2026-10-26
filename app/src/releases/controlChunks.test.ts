import { expect, it } from 'vitest'

import { readControlValue, writeControlValue } from './controlChunks'

/** A small event-driven object store checks record boundaries and reconstruction. */
function store() {
  const values = new Map<string, unknown>()
  const table = {
    put(value: unknown, key: string) {
      values.set(key, structuredClone(value))
      return {}
    },
    get(key: string) {
      const request = {
        result: values.get(key),
        onsuccess: undefined as undefined | (() => void),
      }
      queueMicrotask(() => request.onsuccess?.())
      return request
    },
  } as unknown as IDBObjectStore
  return { table, values }
}
it('round-trips a large control record using only small values', async () => {
  const { table, values } = store()
  const state = { format: 1, manifest: 'large manifest data'.repeat(40000) }
  writeControlValue(table, state, true, (error) => {
    throw error
  })
  for (const value of values.values())
    expect(JSON.stringify(value).length).toBeLessThan(32768)
  await expect(
    new Promise((resolve, reject) =>
      readControlValue(table, values.get('control'), resolve, reject)
    )
  ).resolves.toEqual(state)
})
it('keeps legacy writes compatible and rejects missing chunks', async () => {
  const { table, values } = store()
  const state = { format: 1, tabs: {} }
  writeControlValue(table, state, false, (error) => {
    throw error
  })
  expect(values.get('control')).toEqual(state)
  writeControlValue(table, state, true, (error) => {
    throw error
  })
  values.delete('control-chunk-0')
  await expect(
    new Promise((resolve, reject) =>
      readControlValue(table, values.get('control'), resolve, reject)
    )
  ).rejects.toThrow('Missing or invalid')
})
