import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExampleRequest } from './protocol'

const job = {
  localUri: 'local://file/test',
  sourcePath: 'runme/notebooks/test/document.runme',
  name: 'test.runme',
}

/** Stub the browser Worker message boundary, not the notebook/storage backend. */
function workerStub() {
  const instances: FakeWorker[] = []
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void
    onerror?: () => void
    postMessage = vi.fn<(request: ExampleRequest) => void>()
    terminate = vi.fn()
    constructor() {
      instances.push(this)
    }
    finish(index = 0) {
      const request = this.postMessage.mock.calls[index][0]
      this.onmessage?.({
        data: { id: request.id, kind: request.kind, result: { examples: [] } },
      })
    }
  }
  vi.stubGlobal('Worker', FakeWorker)
  return instances
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('dedicated example worker client', () => {
  it('keeps automatic production off by default but supports explicit inspection', async () => {
    vi.stubEnv('VITE_TRAINING_EXAMPLES', '')
    const workers = workerStub()
    const client = await import('./client')
    client.scheduleTrainingExamples(job)
    expect(workers).toHaveLength(0)
    const result = client.loadTrainingExamples(job)
    expect(workers).toHaveLength(1)
    expect(workers[0].postMessage.mock.calls[0][0]).toEqual({
      id: 1,
      kind: 'generate',
      job,
    })
    workers[0].finish()
    await expect(result).resolves.toEqual({ examples: [] })
  })
  it('coalesces rapid and in-flight writes rather than queuing unbounded histories', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_TRAINING_EXAMPLES', 'true')
    const workers = workerStub()
    const client = await import('./client')
    for (let i = 0; i < 10; i++) client.scheduleTrainingExamples(job)
    await vi.advanceTimersByTimeAsync(500)
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 3; i++) {
      client.scheduleTrainingExamples(job)
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1)
    workers[0].finish()
    await vi.advanceTimersByTimeAsync(500)
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2)
    workers[0].finish(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2)
  })
  it('rejects failed jobs and recreates a worker on retry', async () => {
    const workers = workerStub()
    const client = await import('./client')
    const failed = client.loadTrainingExamples(job)
    const assertion = expect(failed).rejects.toThrow('worker failed')
    workers[0].onerror?.()
    await assertion
    expect(workers[0].terminate).toHaveBeenCalled()
    const retry = client.loadTrainingExamples(job)
    workers[1].finish()
    await expect(retry).resolves.toEqual({ examples: [] })
  })
})
