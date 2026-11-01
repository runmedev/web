// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'

import { installStorageWorkerControl } from '../../storage/storageWorkerControl'
import { WorkerLogBuffer } from '../../storage/workerLog'
import { createLoggingRuntime } from '../logging/runtime'
import { storageWorkerTools } from './storageWorkerTools'

afterEach(() => vi.unstubAllGlobals())

it('direct tools answer before notebook initialization with IndexedDB and OPFS unavailable', async () => {
  vi.stubGlobal('indexedDB', {
    open: () => {
      throw new Error('Must not open IndexedDB')
    },
  })
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => {
        throw new DOMException('Unavailable', 'NotAllowedError')
      },
    },
  })
  const runtime = createLoggingRuntime()
  const logs = new WorkerLogBuffer(runtime, {
    instanceId: 'tool-worker',
    epoch: 0,
  })
  const close = installStorageWorkerControl({
    status: () => ({
      instanceId: 'tool-worker',
      epoch: 0,
      phase: 'initializing-storage',
      phaseElapsedMs: 10000,
      uptimeMs: 11000,
    }),
    phase: () => {},
    close: () => {},
    drain: () => new Promise(() => {}),
    logs: (query) => logs.read(query),
  })
  try {
    runtime.log('warn', 'Storage await still pending', {
      attrs: { scope: 'storage.trace', operation: 'ensure-folder-read' },
    })
    const tools = storageWorkerTools()
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true)
    const status = JSON.parse(
      await tools
        .find((t) => t.name === 'GetStorageWorkerStatus')!
        .execute({ instanceId: 'tool-worker' })
    )
    expect(status.phase).toBe('initializing-storage')
    const result = JSON.parse(
      await tools
        .find((t) => t.name === 'ReadStorageWorkerLogs')!
        .execute({ instanceId: 'tool-worker', timeoutMs: 500 })
    )
    expect(result.events[0].attrs.operation).toBe('ensure-folder-read')
    expect(result.sources).toMatchObject({
      memory: { state: 'available' },
      opfs: { state: 'unavailable' },
    })
    expect(result.partial).toBe(true)
    const sessions = JSON.parse(
      await tools
        .find((t) => t.name === 'ListStorageWorkerSessions')!
        .execute({ timeoutMs: 100 })
    )
    expect(sessions.workers[0].instanceId).toBe('tool-worker')
    expect(sessions.errors).toContain('Persisted worker discovery unavailable')
  } finally {
    close()
    logs.close()
  }
})

it('rejects malformed tool queries before allocating control channels', async () => {
  const read = storageWorkerTools().find(
    (t) => t.name === 'ReadStorageWorkerLogs'
  )!
  await expect(read.execute({ instanceId: '../notebooks' })).rejects.toThrow(
    'instanceId'
  )
  await expect(read.execute({ instanceId: 'one', limit: -1 })).rejects.toThrow(
    'limit'
  )
  await expect(
    read.execute({ instanceId: 'one', minLevel: 'trace' })
  ).rejects.toThrow('minLevel')
})
