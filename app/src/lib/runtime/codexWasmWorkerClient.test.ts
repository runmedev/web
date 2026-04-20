// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { CodexWasmWorkerClient } from './codexWasmWorkerClient'
import type { CodexWasmWorkerResponse } from './codexWasmWorkerProtocol'

class MockWorker {
  onmessage: ((event: MessageEvent<CodexWasmWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postedMessages: unknown[] = []

  postMessage(message: unknown) {
    this.postedMessages.push(message)
  }

  terminate() {}

  dispatchMessage(message: CodexWasmWorkerResponse) {
    this.onmessage?.({
      data: message,
    } as MessageEvent<CodexWasmWorkerResponse>)
  }
}

describe('CodexWasmWorkerClient', () => {
  it('routes bridge requests through the configured code executor', async () => {
    const worker = new MockWorker()
    const client = new CodexWasmWorkerClient({
      workerFactory: () => worker as unknown as Worker,
    })
    const codeExecutor = vi.fn(async () =>
      JSON.stringify({
        output: 'bridge output',
        stored_values: { seen: true },
      })
    )

    client.setCodeExecutor(codeExecutor)

    const connectPromise = client.connect({
      apiKey: 'sk-test',
      moduleUrl: '/generated/codex.js',
      wasmUrl: '/generated/codex.wasm',
    })

    expect(worker.postedMessages[0]).toMatchObject({
      type: 'connect',
      id: 1,
      apiKey: 'sk-test',
    })

    worker.dispatchMessage({
      type: 'response',
      id: 1,
      result: { connected: true },
    })

    await connectPromise

    worker.dispatchMessage({
      type: 'bridge/request',
      bridgeRequestId: 7,
      input: '{"source":"console.log(1)"}',
    })

    await Promise.resolve()

    expect(codeExecutor).toHaveBeenCalledWith('{"source":"console.log(1)"}')
    expect(worker.postedMessages.at(-1)).toMatchObject({
      type: 'bridge/response',
      bridgeRequestId: 7,
      result: JSON.stringify({
        output: 'bridge output',
        stored_values: { seen: true },
      }),
    })
  })
})
