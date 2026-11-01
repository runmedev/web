// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'

import type { WorkerLogEvent } from './workerLog'
import {
  WorkerLogArchive,
  WorkerLogWriter,
  readWorkerArchive,
} from './workerLogArchive'

/** In-memory implementation of browser handles, not a network/backend service. */
class MemoryDirectory {
  kind = 'directory'
  children = new Map<string, MemoryDirectory | MemoryFile>()
  constructor(readonly name = 'root') {}
  async *entries() {
    yield* this.children.entries()
  }
  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {}
  ): Promise<MemoryDirectory> {
    const item = this.children.get(name)
    if (item instanceof MemoryDirectory) return item
    if (!options.create) throw new DOMException('Missing', 'NotFoundError')
    const child = new MemoryDirectory(name)
    this.children.set(name, child)
    return child
  }
  async getFileHandle(
    name: string,
    options: { create?: boolean } = {}
  ): Promise<MemoryFile> {
    const item = this.children.get(name)
    if (item instanceof MemoryFile) return item
    if (!options.create) throw new DOMException('Missing', 'NotFoundError')
    const child = new MemoryFile(name)
    this.children.set(name, child)
    return child
  }
  async removeEntry(name: string) {
    const item = this.children.get(name)
    if (item instanceof MemoryDirectory && item.children.size)
      throw new DOMException('Nonempty', 'InvalidModificationError')
    this.children.delete(name)
  }
}
class MemoryFile {
  kind = 'file'
  content = ''
  modified = Date.now()
  constructor(readonly name: string) {}
  async getFile() {
    return Object.assign(new Blob([this.content]), {
      lastModified: this.modified,
    })
  }
  async createWritable() {
    let pending = ''
    return {
      write: async (body: string) => {
        pending = body
      },
      close: async () => {
        this.content = pending
        this.modified = Date.now()
      },
      abort: async () => {},
    }
  }
}

/** Canonical test event with no notebook payloads. */
function event(sequence: number, instanceId = 'worker-one'): WorkerLogEvent {
  return {
    schemaVersion: 1,
    instanceId,
    epoch: 0,
    sequence,
    id: `event-${sequence}`,
    ts: new Date().toISOString(),
    level: 'info',
    message: 'Storage operation started',
    attrs: { scope: 'storage.trace' },
  }
}
function fixture() {
  const root = new MemoryDirectory()
  const archive = new WorkerLogArchive(
    async () => root as unknown as FileSystemDirectoryHandle
  )
  return { root, archive }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('reads committed chunks after worker exit without IndexedDB or a worker connection', async () => {
  const { archive, root } = fixture()
  vi.stubGlobal('indexedDB', {
    open: () => {
      throw new Error('Forbidden')
    },
  })
  expect(await archive.list()).toEqual([])
  expect(root.children.size).toBe(0)
  await archive.write([event(1), event(2)])
  await archive.write([event(3)])
  await archive.write([event(1, 'worker-two')])
  expect(await archive.list()).toHaveLength(2)
  const first = await archive.read('worker-one', { limit: 2 })
  expect(first.events.map((e) => e.sequence)).toEqual([1, 2])
  expect(first.hasMore).toBe(true)
  const second = await archive.read('worker-one', {
    afterSequence: first.nextSequence,
    limit: 2,
  })
  expect(second.events.map((e) => e.sequence)).toEqual([3])
  expect(second.hasMore).toBe(false)
})

it('isolates corrupt and oversized chunks while advancing the cursor', async () => {
  const { archive, root } = fixture()
  await archive.write([event(1)])
  const dir = await (
    await (
      await (
        await root.getDirectoryHandle('runme-diagnostics')
      ).getDirectoryHandle('storage-workers')
    ).getDirectoryHandle('v1')
  ).getDirectoryHandle('worker-one')
  ;(await dir.getFileHandle('2-2.jsonl', { create: true })).content =
    '{unfinished'
  ;(await dir.getFileHandle('3-3.jsonl', { create: true })).content =
    'x'.repeat(1100000)
  await archive.write([event(4)])
  const page = await archive.read('worker-one')
  expect(page.events.map((e) => e.sequence)).toEqual([1, 4])
  expect(page).toMatchObject({
    nextSequence: 4,
    corruptChunks: 2,
    hasMore: false,
  })
})

it('rotates only diagnostic chunks and keeps notebook files untouched', async () => {
  const { archive, root } = fixture()
  const notebooks = await root.getDirectoryHandle('notebooks', { create: true })
  const original = await notebooks.getFileHandle('important.runme', {
    create: true,
  })
  original.content = 'original notebook bytes'
  for (let i = 1; i <= 70; i++) await archive.write([event(i)])
  const page = await archive.read('worker-one')
  expect(page.events).toHaveLength(64)
  expect(page.events[0].sequence).toBe(7)
  expect(original.content).toBe('original notebook bytes')
  await expect(archive.read('../notebooks')).rejects.toThrow(
    'InvalidDiagnosticInstance'
  )
})

it('keeps one physical write after timeout, bounds queued events, and accepts late completion', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const write = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const writer = new WorkerLogWriter(write)
  writer.append(event(1))
  const flushing = writer.flush()
  await vi.advanceTimersByTimeAsync(5001)
  for (let i = 2; i <= 1000; i++) writer.append(event(i))
  expect(writer.status()).toMatchObject({
    state: 'degraded',
    errorName: 'DiagnosticWriteTimeout',
  })
  expect(writer.status().pendingBytes).toBeLessThanOrEqual(65536)
  expect(writer.status().dropped).toBeGreaterThan(0)
  expect(writer.flush()).toBe(flushing)
  expect(write).toHaveBeenCalledOnce()
  finish()
  await flushing
  expect(writer.status()).toMatchObject({
    state: 'idle',
    lastCommittedSequence: 1,
  })
  writer.close()
  expect(vi.getTimerCount()).toBe(0)
})

it('isolates quota errors and never recursively logs or retries the same chunk', async () => {
  vi.useFakeTimers()
  const write = vi.fn(async () => {
    throw new DOMException('Full', 'QuotaExceededError')
  })
  const writer = new WorkerLogWriter(write)
  writer.append(event(1))
  await expect(writer.flush()).resolves.toBeUndefined()
  expect(writer.status()).toMatchObject({
    state: 'degraded',
    errorName: 'QuotaExceededError',
    dropped: 1,
  })
  await writer.flush()
  expect(write).toHaveBeenCalledOnce()
  writer.append(event(2))
  await vi.advanceTimersByTimeAsync(29999)
  expect(write).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(write).toHaveBeenCalledTimes(2)
  writer.close()
})

it('limits unresolved browser reads and stops scanning when a late await returns', async () => {
  vi.useFakeTimers()
  const completions: Array<() => void> = []
  const execute = async (_archive: WorkerLogArchive, check: () => void) => {
    await new Promise<void>((resolve) => completions.push(resolve))
    check()
    return 'must not resume'
  }
  const first = readWorkerArchive(execute, 100).catch((e) => e.message)
  const second = readWorkerArchive(execute, 100).catch((e) => e.message)
  await vi.advanceTimersByTimeAsync(101)
  expect(await first).toContain('timed out')
  expect(await second).toContain('timed out')
  await expect(readWorkerArchive(execute, 100)).rejects.toThrow('still pending')
  completions.forEach((resolve) => resolve())
  await vi.advanceTimersByTimeAsync(0)
  expect(await readWorkerArchive(async () => 'recovered')).toBe('recovered')
  expect(vi.getTimerCount()).toBe(0)
})

/** Locate the test diagnostics subtree without touching unrelated storage. */
async function archiveRoot(root: MemoryDirectory) {
  return (
    await (
      await root.getDirectoryHandle('runme-diagnostics')
    ).getDirectoryHandle('storage-workers')
  ).getDirectoryHandle('v1')
}

it('isolates files removed during reading and rejects unsafe filename cursors', async () => {
  const { archive, root } = fixture()
  await archive.write([event(1)])
  await archive.write([event(2)])
  await archive.write([event(3)])
  const dir = await (await archiveRoot(root)).getDirectoryHandle('worker-one')
  const removed = await dir.getFileHandle('2-2.jsonl')
  vi.spyOn(removed, 'getFile')
    .mockResolvedValueOnce(await removed.getFile())
    .mockRejectedValueOnce(new DOMException('Rotated', 'NotFoundError'))
  const unreadable = await dir.getFileHandle('3-3.jsonl')
  const metadata = await unreadable.getFile()
  vi.spyOn(unreadable, 'getFile')
    .mockResolvedValueOnce(metadata)
    .mockResolvedValueOnce(
      Object.assign(metadata, {
        text: async () => {
          throw new DOMException('Unavailable', 'NotReadableError')
        },
      })
    )
  await dir.getFileHandle('1-99999999999999999999.jsonl', { create: true })
  const page = await archive.read('worker-one')
  expect(page.events.map((e) => e.sequence)).toEqual([1])
  expect(page.corruptChunks).toBe(2)
  expect(page.nextSequence).toBe(3)
  expect(page.latestSequence).toBe(3)
})

it('enforces origin and instance byte budgets across workers without touching notebooks', async () => {
  const { archive, root } = fixture()
  const notebook = await root.getFileHandle('keep.runme', { create: true })
  notebook.content = 'original notebook bytes'
  // Four individually bounded events nearly fill each immutable chunk.
  const batch = (n: number, instance: string) =>
    Array.from({ length: 4 }, (_, i) => ({
      ...event(n * 4 + i + 1, instance),
      attrs: { scope: 'storage.test', phase: 'x'.repeat(14000) },
    }))
  for (let n = 0; n < 45; n++) await archive.write(batch(n, 'large-worker'))
  expect((await archive.list())[0].bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
  for (let n = 0; n < 380; n++) await archive.write(batch(0, `worker-${n}`))
  const sessions = await archive.list()
  expect(sessions.reduce((n, s) => n + s.bytes, 0)).toBeLessThanOrEqual(
    20 * 1024 * 1024
  )
  expect(sessions.find((s) => s.instanceId === 'worker-379')).toBeDefined()
  expect(sessions.length).toBeLessThan(380)
  expect(notebook.content).toBe('original notebook bytes')
}, 15000)

it('expires recognized old diagnostic files while preserving unknown files', async () => {
  const { archive, root } = fixture()
  await archive.write([event(1)])
  const dir = await (await archiveRoot(root)).getDirectoryHandle('worker-one')
  ;(await dir.getFileHandle('1-1.jsonl')).modified = Date.now() - 8 * 86400000
  ;(await dir.getFileHandle('unknown-format', { create: true })).content =
    'keep'
  await archive.write([event(1, 'new-worker')])
  expect(dir.children.has('1-1.jsonl')).toBe(false)
  expect((await dir.getFileHandle('unknown-format')).content).toBe('keep')
  expect((await archive.list()).map((s) => s.instanceId)).toEqual([
    'new-worker',
  ])
})
