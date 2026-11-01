// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'

import { createLoggingRuntime } from '../lib/logging/runtime'
import {
  StorageWorkerControl,
  installStorageWorkerControl,
} from './storageWorkerControl'
import {
  getStorageWorkerStatus,
  listStorageWorkers,
  readStorageWorkerMemory,
  restartStorageWorker,
} from './workerDiagnostics'
import { WorkerLogBuffer } from './workerLog'

const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).forEach((f) => f())
  vi.unstubAllGlobals()
})

/** Real BroadcastChannels exercise control while notebook initialization is absent. */
function worker(instanceId = 'test-worker', drain = async () => {}) {
  let phase = 'waiting-for-lock'
  const runtime = createLoggingRuntime()
  const buffer = new WorkerLogBuffer(runtime, { instanceId, epoch: 1 })
  const close = vi.fn()
  cleanup.push(
    () => buffer.close(),
    installStorageWorkerControl({
      status: () => ({
        instanceId,
        epoch: 1,
        phase,
        phaseElapsedMs: 10,
        uptimeMs: 20,
        logProtocol: 1,
      }),
      phase: (next) => {
        phase = next
      },
      drain,
      close,
      logs: (query) => buffer.read(query),
    })
  )
  runtime.log('info', 'waiting on ownership lock', {
    attrs: { scope: 'storage.owner', phase },
  })
  return { runtime, close }
}

it('discovers and reads logs with no notebook connection and IndexedDB unavailable', async () => {
  vi.stubGlobal('indexedDB', {
    open: () => {
      throw new Error('IDB must not be used')
    },
  })
  worker()
  expect(
    await getStorageWorkerStatus({ instanceId: 'test-worker' })
  ).toMatchObject({ phase: 'waiting-for-lock' })
  const page = await readStorageWorkerMemory({ instanceId: 'test-worker' })
  expect(page.events[0]).toMatchObject({
    instanceId: 'test-worker',
    sequence: 1,
    message: 'waiting on ownership lock',
  })
  expect(await listStorageWorkers({ timeoutMs: 100 })).toMatchObject({
    discoveryComplete: false,
    workers: [expect.objectContaining({ instanceId: 'test-worker' })],
  })
})

it('targets only the requested instance and distinguishes stopped from replacement ready', async () => {
  const selected = worker('selected')
  const other = worker('other')
  const result = await restartStorageWorker({ instanceId: 'selected' })
  expect(result).toMatchObject({
    instanceId: 'selected',
    outcome: 'stopped',
    replacementReady: false,
    force: false,
  })
  expect(selected.close).toHaveBeenCalledOnce()
  expect(other.close).not.toHaveBeenCalled()
})

it('does not escalate a stalled drain, but still answers diagnostics and explicit force', async () => {
  const drain = vi.fn(() => new Promise<void>(() => {}))
  const selected = worker('stalled', drain)
  expect(
    await restartStorageWorker({ instanceId: 'stalled', timeoutMs: 100 })
  ).toMatchObject({ outcome: 'unknown', force: false })
  expect(selected.close).not.toHaveBeenCalled()
  expect(await getStorageWorkerStatus({ instanceId: 'stalled' })).toMatchObject(
    { phase: 'draining' }
  )
  expect(
    (await readStorageWorkerMemory({ instanceId: 'stalled' })).events
  ).toHaveLength(1)
  expect(
    await restartStorageWorker({ instanceId: 'stalled', mode: 'force' })
  ).toMatchObject({ outcome: 'stopped', force: true })
  expect(selected.close).toHaveBeenCalledOnce()
  expect(drain).toHaveBeenCalledOnce()
})

it('returns unknown for a missing worker, never treating a timeout as termination', async () => {
  expect(
    await restartStorageWorker({ instanceId: 'missing', timeoutMs: 100 })
  ).toMatchObject({ outcome: 'unknown', replacementReady: false })
  await expect(
    getStorageWorkerStatus({ instanceId: 'missing', timeoutMs: 100 })
  ).rejects.toThrow('does not prove termination')
  expect(() => restartStorageWorker({ instanceId: '' })).toThrow(
    'concrete worker'
  )
  expect(() =>
    restartStorageWorker({ instanceId: 'one', mode: 'auto' as 'force' })
  ).toThrow('mode must be')
})

it('rejects outstanding reads on close instead of leaking timers', async () => {
  const control = new StorageWorkerControl(() => {})
  const pending = control.readLogs('missing')
  control.close()
  await expect(pending).rejects.toThrow('connection closed')
})

it('identifies unsupported logs on a historical worker', async () => {
  cleanup.push(
    installStorageWorkerControl({
      status: () => ({
        instanceId: 'old',
        epoch: 0,
        phase: 'ready',
        phaseElapsedMs: 0,
        uptimeMs: 0,
      }),
      phase: () => {},
      drain: async () => {},
      close: () => {},
    })
  )
  await expect(readStorageWorkerMemory({ instanceId: 'old' })).rejects.toThrow(
    'unsupported'
  )
})
