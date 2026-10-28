// @vitest-environment node
import { expect, it, vi } from 'vitest'

import {
  StorageWorkerControl,
  type WorkerControlEvent,
  installStorageWorkerControl,
} from './storageWorkerControl'

it('answers diagnostics during a stalled drain and allows force close without tab acknowledgements', async () => {
  let phase = 'initializing-storage'
  const close = vi.fn()
  const drain = vi.fn(() => new Promise<void>(() => {}))
  const dispose = installStorageWorkerControl({
    status: () => ({
      instanceId: 'stalled',
      epoch: 0,
      phase,
      phaseElapsedMs: 100,
      uptimeMs: 200,
    }),
    phase: (value) => {
      phase = value
    },
    drain,
    close,
  })
  const events: WorkerControlEvent[] = []
  const client = new StorageWorkerControl((event) => {
    events.push(event)
  })
  try {
    client.discover()
    await vi.waitFor(() =>
      expect(events.at(-1)?.status.phase).toBe('initializing-storage')
    )
    client.stop('unrelated-worker', { force: true, restart: true })
    client.stop('stalled', { force: false, restart: true })
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce())
    expect(close).not.toHaveBeenCalled()
    client.discover()
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        type: 'status',
        status: { phase: 'draining' },
      })
    )
    client.stop('stalled', { force: true, restart: true })
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ type: 'stopped', restart: true })
    )
    expect(close).toHaveBeenCalledOnce()
    expect(drain).toHaveBeenCalledOnce()
  } finally {
    client.close()
    dispose()
  }
})
