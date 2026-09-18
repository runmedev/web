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

  it('replays unavailable state and clears it only after successful negotiation', async () => {
    const streams = new Streams({
      knownID: 'cell',
      runID: 'run',
      sequence: 1,
      options: {
        runnerEndpoint: 'ws://localhost:9977/ws',
        interceptors: [],
        autoReconnect: true,
      },
    })
    streams.connect(Heartbeat.INITIAL).subscribe()
    expect(streams.connectionStateSnapshot).toBe('connecting')
    MockWebSocket.instances[0].failConnection()
    const states: string[] = []
    const subscription = streams.connectionState.subscribe((state) =>
      states.push(state)
    )
    expect(states).toEqual(['unavailable'])
    await vi.advanceTimersByTimeAsync(1_000)
    MockWebSocket.instances[1].open()
    expect(streams.connectionStateSnapshot).toBe('unavailable')
    MockWebSocket.instances[1].receive({
      openRunResponse: { state: 'RUN_STATE_CREATED' },
    })
    expect(streams.connectionStateSnapshot).toBe('connected')
    MockWebSocket.instances[1].failConnection()
    expect(streams.connectionStateSnapshot).toBe('unavailable')
    await vi.advanceTimersByTimeAsync(1_000)
    MockWebSocket.instances[2].open()
    MockWebSocket.instances[2].receive({
      openRunResponse: { state: 'RUN_STATE_RUNNING' },
    })
    expect(streams.connectionStateSnapshot).toBe('connected')
    subscription.unsubscribe()
    streams.close()
  })

  it.each([false, true])(
    'reports a stalled connection or handshake without a false execution failure (open=%s)',
    async (open) => {
      const streams = new Streams({
        knownID: 'cell',
        runID: 'run',
        sequence: 1,
        options: {
          runnerEndpoint: 'ws://localhost:9977/ws',
          interceptors: [],
          autoReconnect: true,
        },
      })
      const errors: unknown[] = []
      streams.errors.subscribe((error) => errors.push(error))
      streams.connect(Heartbeat.INITIAL).subscribe()
      if (open) MockWebSocket.instances[0].open()
      await vi.advanceTimersByTimeAsync(9_999)
      expect(streams.connectionStateSnapshot).toBe('connecting')
      await vi.advanceTimersByTimeAsync(1)
      expect(streams.connectionStateSnapshot).toBe('unavailable')
      expect(errors).toEqual([])
      if (!open) MockWebSocket.instances[0].open()
      MockWebSocket.instances[0].receive({
        openRunResponse: { state: 'RUN_STATE_CREATED' },
      })
      expect(streams.connectionStateSnapshot).toBe('connected')
      streams.close()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(streams.connectionStateSnapshot).toBe('closed')
    }
  )

  it('cancels the pending notice after successful negotiation', async () => {
    const streams = new Streams({
      knownID: 'cell',
      runID: 'run',
      sequence: 1,
      options: {
        runnerEndpoint: 'ws://localhost:9977/ws',
        interceptors: [],
        autoReconnect: false,
      },
    })
    streams.connect(Heartbeat.INITIAL).subscribe()
    MockWebSocket.instances[0].open()
    MockWebSocket.instances[0].receive({
      openRunResponse: { state: 'RUN_STATE_CREATED' },
    })
    await vi.advanceTimersByTimeAsync(11_000)
    expect(streams.connectionStateSnapshot).toBe('connected')
    streams.close()
  })

  it('cleans up the connection notice when closed before connecting', async () => {
    const streams = new Streams({
      knownID: 'cell',
      runID: 'run',
      sequence: 1,
      options: {
        runnerEndpoint: 'ws://localhost:9977/ws',
        interceptors: [],
        autoReconnect: true,
      },
    })
    streams.connect().subscribe()
    streams.close()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(streams.connectionStateSnapshot).toBe('closed')
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it.each([true, false])(
    'handles a close without a browser error (reconnect=%s)',
    async (autoReconnect) => {
      const streams = new Streams({
        knownID: 'cell',
        runID: 'run',
        sequence: 1,
        options: {
          runnerEndpoint: 'ws://localhost:9977/ws',
          interceptors: [],
          autoReconnect,
        },
      })
      const errors: unknown[] = []
      streams.errors.subscribe((error) => errors.push(error))
      streams.connect().subscribe()
      MockWebSocket.instances[0].dispatchEvent(
        new CloseEvent('close', { code: 1005 })
      )
      expect(streams.connectionStateSnapshot).toBe('unavailable')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(MockWebSocket.instances).toHaveLength(autoReconnect ? 2 : 1)
      expect(errors).toHaveLength(autoReconnect ? 0 : 1)
      streams.close()
    }
  )

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
