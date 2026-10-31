// @vitest-environment node
import type Dexie from 'dexie'
import { expect, it, vi } from 'vitest'

import { boundedTransaction } from './boundedStorage'

const active = vi.hoisted(() => ({ abort: vi.fn() }))
vi.mock('dexie', () => ({
  default: {
    get currentTransaction() {
      return active
    },
  },
}))

it('does not apply a queued write after its caller abandons it', async () => {
  let start!: () => void
  const queued = new Promise<void>((resolve) => {
    start = resolve
  })
  const action = vi.fn(async () => {})
  const db = {
    name: 'test-console',
    open: async () => {},
    transaction: async (
      _mode: unknown,
      _tables: unknown,
      callback: () => Promise<void>
    ) => {
      await queued
      return callback()
    },
  } as unknown as Dexie
  const controller = new AbortController()
  const pending = boundedTransaction(
    db,
    'rw',
    ['cells'],
    'write',
    action,
    controller.signal
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort()
  await expect(pending).rejects.toThrow()
  start()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(action).not.toHaveBeenCalled()
})

it('does not create a transaction when an abandoned database open finishes late', async () => {
  let opened!: () => void
  const transaction = vi.fn()
  const db = {
    name: 'test-console',
    open: () =>
      new Promise<void>((resolve) => {
        opened = resolve
      }),
    transaction,
  } as unknown as Dexie
  const controller = new AbortController()
  const pending = boundedTransaction(
    db,
    'rw',
    ['cells'],
    'write',
    async () => {},
    controller.signal
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort()
  await expect(pending).rejects.toThrow()
  opened()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(transaction).not.toHaveBeenCalled()
})

it('aborts the active transaction when its deadline expires', async () => {
  vi.useFakeTimers()
  active.abort.mockClear()
  const db = {
    name: 'test-console',
    open: async () => {},
    transaction: async (
      _mode: unknown,
      _tables: unknown,
      callback: () => Promise<void>
    ) => callback(),
  } as unknown as Dexie
  const pending = boundedTransaction(
    db,
    'rw',
    ['cells'],
    'write',
    () => new Promise(() => {})
  )
  const rejection = expect(pending).rejects.toThrow('Storage timeout')
  try {
    await vi.advanceTimersByTimeAsync(1500)
    await rejection
    expect(active.abort).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})
