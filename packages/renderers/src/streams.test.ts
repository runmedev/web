import { ExecuteRequestSchema } from '@buf/runmedev_runme.bufbuild_es/runme/runner/v2/runner_pb'
import { create } from '@bufbuild/protobuf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Streams, { Heartbeat, RunIntent } from './streams'

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

  receive(data: object): void {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(data) })
    )
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
        message.includes('RUN_INTENT_START')
      )
    ).toBe(true)
    expect(
      MockWebSocket.instances[1].sent.some((message) =>
        message.includes('executeRequest')
      )
    ).toBe(false)

    MockWebSocket.instances[1].receive({
      openRunResponse: { state: 'RUN_STATE_CREATED' },
    })
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

  it('keeps retrying when the runner is unreachable', async () => {
    const streams = new Streams({
      knownID: 'cell-unreachable',
      runID: 'run-unreachable',
      sequence: 2,
      options: {
        runnerEndpoint: 'ws://localhost:9977/ws',
        interceptors: [],
        autoReconnect: true,
        initialIntent: RunIntent.RESUME,
      },
    })
    const errors: unknown[] = []
    const errorSubscription = streams.errors.subscribe((error) => {
      errors.push(error)
    })

    streams.connect(Heartbeat.INITIAL).subscribe()

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(MockWebSocket.instances).toHaveLength(attempt + 1)
      MockWebSocket.instances[attempt].failConnection()
      await vi.advanceTimersByTimeAsync(1_000)
    }

    expect(MockWebSocket.instances).toHaveLength(5)
    expect(errors).toEqual([])

    errorSubscription.unsubscribe()
    streams.close()
  })

  it('uses resume intent before reconnecting a persisted run', async () => {
    const streams = new Streams({
      knownID: 'cell-resume',
      runID: 'run-resume',
      sequence: 7,
      options: {
        runnerEndpoint: 'ws://localhost:9977/ws',
        interceptors: [],
        autoReconnect: true,
        initialIntent: RunIntent.RESUME,
      },
    })

    streams.connect(Heartbeat.INITIAL).subscribe()
    expect(MockWebSocket.instances).toHaveLength(1)

    MockWebSocket.instances[0].open()
    await Promise.resolve()
    await Promise.resolve()

    expect(
      MockWebSocket.instances[0].sent.some((message) =>
        message.includes('RUN_INTENT_RESUME')
      )
    ).toBe(true)

    MockWebSocket.instances[0].receive({
      openRunResponse: { state: 'RUN_STATE_RUNNING' },
    })
    await Promise.resolve()

    streams.close()
  })

  it('reports a missing resumed run as a terminal protocol error', async () => {
    const streams = new Streams({
      knownID: 'cell-missing',
      runID: 'run-missing',
      sequence: 8,
      options: {
        runnerEndpoint: 'ws://localhost:9977/ws',
        interceptors: [],
        autoReconnect: true,
        initialIntent: RunIntent.RESUME,
      },
    })
    const errors: unknown[] = []
    const errorSubscription = streams.errors.subscribe((error) => {
      errors.push(error)
    })

    streams.connect(Heartbeat.INITIAL).subscribe({ error: () => undefined })
    MockWebSocket.instances[0].open()
    await Promise.resolve()
    await Promise.resolve()

    MockWebSocket.instances[0].receive({
      status: { code: 'NOT_FOUND', message: 'run not found' },
    })
    await Promise.resolve()

    expect(errors).toHaveLength(1)
    expect(MockWebSocket.instances).toHaveLength(1)

    errorSubscription.unsubscribe()
    streams.close()
  })
})
