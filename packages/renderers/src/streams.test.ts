import { ExecuteRequestSchema } from '@buf/runmedev_runme.bufbuild_es/runme/runner/v2/runner_pb'
import { create } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Streams, { Heartbeat } from './streams'

class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static instances: MockWebSocket[] = []

  readonly sent: string[] = []
  readyState = MockWebSocket.CONNECTING

  constructor(readonly url: string) {
    super()
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
  }

  failConnection(): void {
    this.dispatchEvent(new Event('error'))
    this.readyState = MockWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code: 1006 }))
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }
}

describe('Streams', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps the first execute request queued while the runner starts', async () => {
    const streams = new Streams({
      knownID: 'cell-first-run',
      runID: 'run-first-run',
      sequence: 1,
      options: {
        runnerEndpoint: 'ws://localhost:9977/ws',
        interceptors: [],
        autoReconnect: true,
      },
    })
    const errors: unknown[] = []
    const errorSubscription = streams.errors.subscribe((error) => {
      errors.push(error)
    })

    streams.connect(Heartbeat.INITIAL).subscribe()
    streams.sendExecuteRequest(
      create(ExecuteRequestSchema, {
        config: {
          languageId: 'bash',
        },
      })
    )

    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0].failConnection()
    expect(errors).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(MockWebSocket.instances).toHaveLength(2)

    MockWebSocket.instances[1].open()
    await Promise.resolve()
    await Promise.resolve()

    expect(
      MockWebSocket.instances[1].sent.some((message) =>
        message.includes('executeRequest')
      )
    ).toBe(true)
    expect(errors).toEqual([])

    errorSubscription.unsubscribe()
    streams.close()
  })
})
