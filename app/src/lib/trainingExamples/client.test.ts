import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExampleRequest } from './protocol'
const job = { localUri: 'local://file/test', sourcePath: 'runme/notebooks/test/document.runme', name: 'test.runme' }

/** Stub only the Worker message transport, not a backend server. */
function workerStub() {
  const instances: FakeWorker[] = []
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void
    onerror?: () => void
    postMessage = vi.fn<(request: ExampleRequest) => void>()
    terminate = vi.fn()
    constructor() { instances.push(this) }
    finish() {
      const request = this.postMessage.mock.calls[0][0]
      this.onmessage?.({ data: { id: request.id, kind: request.kind, result: { examples: [] } } })
    }
  }
  vi.stubGlobal('Worker', FakeWorker)
  return instances
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
describe('explicit dedicated worker client', () => {
  it('does not start a worker on import; forwards explicit extraction options', async () => {
    const workers = workerStub()
    const client = await import('./client')
    expect(workers).toHaveLength(0)
    expect('scheduleTrainingExamples' in client).toBe(false)
    const result = client.loadTrainingExamples(job, { sources: ['named-revision'] })
    expect(workers[0].postMessage).toHaveBeenCalledWith({ id: 1, kind: 'generate', job, options: { sources: ['named-revision'] } })
    workers[0].finish()
    await expect(result).resolves.toEqual({ examples: [] })
  })
  it('cancels pending CPU work and can be restarted explicitly', async () => {
    const workers = workerStub()
    const client = await import('./client')
    const pending = client.loadTrainingExamples(job)
    const assertion = expect(pending).rejects.toThrow('cancelled')
    client.cancelTrainingExamples()
    await assertion
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    const next = client.loadTrainingExamples(job)
    workers[1].finish()
    await expect(next).resolves.toEqual({ examples: [] })
  })
  it('rejects failed jobs and does not retain them on worker restart', async () => {
    const workers = workerStub(); const client = await import('./client')
    const assertion = expect(client.loadTrainingExamples(job)).rejects.toThrow('worker failed')
    workers[0].onerror?.(); await assertion
    expect(workers[0].terminate).toHaveBeenCalledOnce()
  })
})
