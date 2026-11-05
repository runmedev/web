import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentMonitor } from './monitor'
import type { AgentEvent, AgentItem, AgentTransport } from './types'

const item = (id: string, text = id): AgentItem => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
})
const page = (ids: string[], has_more = false) => ({
  data: ids.map((id) => item(id)),
  has_more,
  last_id: ids[ids.length - 1] ?? null,
})
const models: AgentMonitor[] = []
afterEach(() => {
  models.forEach((model) => model.pause())
  models.length = 0
  vi.useRealTimers()
})

/** In-memory stream fixture exercises the controller without a fake network server. */
function setup(overrides: Partial<AgentTransport> = {}) {
  let deliver: ((value: IteratorResult<AgentEvent>) => void) | undefined
  const queued: AgentEvent[] = []
  const close = vi.fn(() => deliver?.({ done: true, value: undefined }))
  const transport: AgentTransport = {
    updateAgent: vi.fn(async () => ({ id: 'agent_test' })),
    createSession: vi.fn(async () => ({ id: 'sess_test' })),
    sendMessage: vi.fn(async () => {}),
    session: vi.fn(async () => ({ status: 'idle' })),
    items: vi.fn(async () => {
      throw new Error('Session-wide items must not be used')
    }),
    turnItems: vi.fn(async () => page(['b', 'a'], true)),
    turns: vi.fn(async () => ({
      data: [
        { id: 'root', status: 'completed', subagent_id: null, created_at: 1 },
      ],
      has_more: false,
      last_id: 'root',
    })),
    stream: vi.fn(async () => ({
      close,
      events: {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            queued.length
              ? Promise.resolve({ done: false, value: queued.shift()! })
              : new Promise<IteratorResult<AgentEvent>>((resolve) => {
                  deliver = resolve
                }),
        }),
      },
    })),
    ...overrides,
  }
  const model = new AgentMonitor(
    { version: 1, id: 'widget', sessionId: 'sess_test', pageSize: 2 },
    () => transport
  )
  models.push(model)
  return {
    model,
    transport,
    close,
    push: (event: AgentEvent) => {
      if (deliver) {
        const next = deliver
        deliver = undefined
        next({ done: false, value: event })
      } else queued.push(event)
    },
  }
}

describe('AgentMonitor', () => {
  it('refreshes saved items without interrupting an in-flight message submission', async () => {
    vi.useFakeTimers()
    let resolveSend!: () => void
    let sendSignal!: AbortSignal
    const { model, transport } = setup({
      sendMessage: (_id, _text, _key, signal) => {
        sendSignal = signal
        return new Promise<void>((resolve) => {
          resolveSend = resolve
        })
      },
    })
    await model.connect()
    model.setDraft('Continue the work')
    const sending = model.sendMessage()
    model.applyEvent({
      type: 'agent.session.turn.completed',
      turn: {
        id: 'root',
        subagent_id: null,
        status: 'completed',
        created_at: 1,
      },
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sendSignal.aborted).toBe(false)
    expect(transport.stream).toHaveBeenCalledTimes(1)
    resolveSend()
    expect(await sending).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(transport.stream).toHaveBeenCalledTimes(1)
    expect(transport.turnItems).toHaveBeenCalledTimes(3)
  })

  it('keeps failed submissions retryable without duplication and requires live observation', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValue(undefined)
    const { model, transport } = setup({ sendMessage })
    model.setDraft('Hello\nagent')
    expect(await model.sendMessage()).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
    await model.connect()
    expect(await model.sendMessage()).toBe(false)
    expect(model.getSnapshot().draft).toBe('Hello\nagent')
    expect(model.getSnapshot().sendError).toContain('Could not confirm')
    await model.connect()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(await model.sendMessage()).toBe(true)
    expect(sendMessage.mock.calls[0].slice(0, 3)).toEqual(
      sendMessage.mock.calls[1].slice(0, 3)
    )
    expect(sendMessage.mock.calls[0][0]).toBe('sess_test')
    expect(transport.stream).toHaveBeenCalled()
    expect(model.getSnapshot().draft).toBe('')
    model.setDraft('Hello\nagent')
    await model.sendMessage()
    expect(sendMessage.mock.calls[2][2]).not.toBe(sendMessage.mock.calls[1][2])
  })

  it('prevents double sends, preserves input and aborts pending delivery when paused', async () => {
    let signal: AbortSignal | undefined
    const sendMessage = vi.fn(
      (_id, _text, _key, requestSignal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal = requestSignal
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const { model } = setup({ sendMessage })
    await model.connect()
    model.setDraft('  ')
    expect(await model.sendMessage()).toBe(false)
    model.setDraft('Keep this draft')
    const pending = model.sendMessage()
    expect(model.getSnapshot().sending).toBe(true)
    expect(await model.sendMessage()).toBe(false)
    model.setDraft('ignored while sending')
    model.pause()
    expect(await pending).toBe(false)
    expect(signal?.aborted).toBe(true)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(model.getSnapshot()).toMatchObject({
      draft: 'Keep this draft',
      sending: false,
    })
  })

  it('times out uncertain sends and reuses the submission ID after a timeout', async () => {
    vi.useFakeTimers()
    const sendMessage = vi
      .fn()
      .mockImplementationOnce(
        (_id, _text, _key, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('timeout')))
          })
      )
      .mockResolvedValue(undefined)
    const { model } = setup({ sendMessage })
    await model.connect()
    model.setDraft('hello')
    const sending = model.sendMessage()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await sending).toBe(false)
    await model.sendMessage()
    expect(sendMessage.mock.calls[0][2]).toBe(sendMessage.mock.calls[1][2])
  })

  it('does not regress final items or root turns when older events arrive', async () => {
    const { model } = setup()
    await model.connect()
    model.applyEvent({
      type: 'agent.session.turn.item.added',
      item: { ...item('b', 'stale'), status: 'in_progress' },
    })
    model.applyEvent(
      {
        type: 'agent.session.turn.in_progress',
        turn: {
          id: 'root',
          subagent_id: null,
          created_at: 1,
          status: 'in_progress',
        },
      },
      true
    )
    expect(model.getSnapshot().items.at(-1)?.content?.[0].text).toBe('b')
    expect(model.getSnapshot().turn?.status).toBe('completed')
  })
  it('loads one descending page, renders chronologically and does not confuse idle with success', async () => {
    const { model, transport } = setup()
    await model.connect()
    expect(transport.turnItems).toHaveBeenCalledWith(
      'sess_test',
      'root',
      2,
      undefined,
      expect.any(AbortSignal)
    )
    expect(model.getSnapshot().items.map((x) => x.id)).toEqual(['a', 'b'])
    expect(model.getSnapshot().turn?.id).toBe('root')
    expect(model.getSnapshot().connection).toBe('live')
  })
  it('deduplicates deltas, accepts done without deltas, and ignores late deltas', async () => {
    const { model } = setup()
    await model.connect()
    const delta = {
      type: 'agent.session.turn.output_text.delta',
      event_id: 'e',
      item_id: 'c',
      output_index: 0,
      content_index: 0,
      delta: 'partial',
    }
    model.applyEvent(delta)
    model.applyEvent(delta)
    expect(model.getSnapshot().items.at(-1)?.content?.[0].text).toBe('partial')
    model.applyEvent({
      ...delta,
      type: 'agent.session.turn.output_text.done',
      event_id: 'done',
      text: '**complete**',
    })
    model.applyEvent({ ...delta, event_id: 'late' })
    expect(model.getSnapshot().items.at(-1)?.content?.[0].text).toBe(
      '**complete**'
    )
    model.applyEvent({
      ...delta,
      type: 'agent.session.turn.output_text.done',
      event_id: 'other',
      item_id: 'd',
      text: 'No deltas',
    })
    expect(model.getSnapshot().items.at(-1)?.content?.[0].text).toBe(
      'No deltas'
    )
  })
  it('prepends history and retains the continuous timeline while live events arrive', async () => {
    const { model, transport } = setup({
      turnItems: vi.fn(async (_id, _turn, _limit, after) =>
        after ? page(['old2', 'old1']) : page(['b', 'a'], true)
      ),
    })
    await model.connect()
    model.setFollowing(false)
    await model.older()
    model.applyEvent({ type: 'agent.session.turn.item.added', item: item('c') })
    expect(model.getSnapshot().items.map((x) => x.id)).toEqual([
      'old1',
      'old2',
      'a',
      'b',
      'c',
    ])
    expect(model.getSnapshot().newActivity).toBe(1)
    expect(transport.turnItems).toHaveBeenLastCalledWith(
      'sess_test',
      'root',
      2,
      'a',
      expect.any(AbortSignal)
    )
    model.latest()
    expect(model.getSnapshot().items.map((x) => x.id)).toEqual([
      'old1',
      'old2',
      'a',
      'b',
      'c',
    ])
    expect(model.getSnapshot().newActivity).toBe(0)
  })
  it('ignores child turn completion and idle when tracking the root turn', async () => {
    const { model } = setup()
    await model.connect()
    model.applyEvent({
      type: 'agent.session.turn.in_progress',
      turn: {
        id: 'next',
        status: 'in_progress',
        subagent_id: null,
        created_at: 2,
      },
    })
    model.applyEvent({
      type: 'agent.session.turn.completed',
      turn: {
        id: 'child',
        subagent_id: 'sub_1',
        status: 'completed',
        created_at: 3,
      },
    })
    model.applyEvent({
      type: 'agent.session.idle',
      session: { status: 'idle' },
    })
    expect(model.getSnapshot().turn?.status).toBe('in_progress')
  })
  it('buffers during hydration and drops replayed deltas for finalized saved items', async () => {
    let resolvePage!: (value: ReturnType<typeof page>) => void
    const { model, push } = setup({
      turnItems: () =>
        new Promise((resolve) => {
          resolvePage = resolve
        }),
    })
    const ready = model.connect()
    await vi.waitFor(() => expect(resolvePage).toBeTypeOf('function'))
    push({
      type: 'agent.session.turn.output_text.delta',
      item_id: 'b',
      output_index: 0,
      content_index: 0,
      delta: ' duplicate',
    })
    await Promise.resolve()
    resolvePage(page(['b', 'a']))
    await ready
    expect(model.getSnapshot().items.at(-1)?.content?.[0].text).toBe('b')
  })
  it('does not revive a monitor after pause during hydration', async () => {
    let resolvePage!: (value: ReturnType<typeof page>) => void
    const { model, close } = setup({
      turnItems: () =>
        new Promise((resolve) => {
          resolvePage = resolve
        }),
    })
    const ready = model.connect()
    await vi.waitFor(() => expect(resolvePage).toBeTypeOf('function'))
    model.pause()
    resolvePage(page(['late']))
    await ready
    expect(model.getSnapshot().connection).toBe('paused')
    expect(model.getSnapshot().items).toEqual([])
    expect(close).toHaveBeenCalled()
  })
  it('shows stream EOF as disconnected and preserves items', async () => {
    const { model, close } = setup()
    await model.connect()
    close()
    await vi.waitFor(() =>
      expect(model.getSnapshot().connection).toBe('disconnected')
    )
    expect(model.getSnapshot().items).toHaveLength(2)
  })
  it('refuses a non-advancing or missing history cursor', async () => {
    const { model } = setup({
      turnItems: async () => ({ ...page(['b', 'a'], true), last_id: null }),
    })
    await model.connect()
    await model.older()
    expect(model.getSnapshot().historyError).toContain('pagination cursor')
  })
  it('caps activity and preserves legacy null IDs', async () => {
    const { model } = setup({
      turnItems: async () => ({
        data: [item('a'), { ...item('legacy'), id: null }],
        has_more: false,
        last_id: null,
      }),
    })
    await model.connect()
    expect(model.getSnapshot().items).toHaveLength(2)
    for (let i = 0; i < 110; i++)
      model.applyEvent({ type: 'future.event', event_id: `e${i}` })
    expect(model.getSnapshot().events).toHaveLength(100)
  })
  it('keeps streaming after a history failure and retries without reconnecting', async () => {
    const turnItems = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 500 Request ID: req_test'))
      .mockResolvedValue(page(['b', 'a']))
    const { model, transport, push, close } = setup({ turnItems })
    await model.connect()
    expect(model.getSnapshot()).toMatchObject({
      connection: 'live',
      historyError: 'HTTP 500 Request ID: req_test',
    })
    push({ type: 'agent.session.turn.item.added', item: item('c') })
    await vi.waitFor(() =>
      expect(model.getSnapshot().items.map((x) => x.id)).toEqual(['c'])
    )
    await model.retryHistory()
    expect(model.getSnapshot().items.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(model.getSnapshot().historyError).toBeNull()
    expect(close).not.toHaveBeenCalled()
    expect(transport.stream).toHaveBeenCalledTimes(1)
    expect(transport.items).not.toHaveBeenCalled()
  })
  it('paginates items then earlier turn pages, skipping subagents and empty turns', async () => {
    const turns = vi.fn(async (_id, _signal, after) =>
      after
        ? {
            data: [{ id: 'old', subagent_id: null }],
            last_id: 'old',
            has_more: false,
          }
        : {
            data: [
              { id: 'root', subagent_id: null },
              { id: 'child', subagent_id: 'sub' },
              { id: 'empty', subagent_id: null },
            ],
            last_id: 'empty',
            has_more: true,
          }
    )
    const turnItems = vi.fn(async (_id, turn, _limit, after) =>
      turn === 'empty'
        ? page([])
        : turn === 'old'
          ? page(['z'])
          : after
            ? page(['c'])
            : page(['b', 'a'], true)
    )
    const { model } = setup({ turns, turnItems })
    await model.connect()
    await model.older()
    await model.older()
    expect(model.getSnapshot().items.map((x) => x.id)).toEqual([
      'z',
      'c',
      'a',
      'b',
    ])
    expect(model.getSnapshot().hasOlder).toBe(false)
    expect(turns).toHaveBeenLastCalledWith(
      'sess_test',
      expect.any(AbortSignal),
      'empty'
    )
    expect(turnItems.mock.calls.map((x) => [x[1], x[3]])).toEqual([
      ['root', undefined],
      ['root', 'a'],
      ['empty', undefined],
      ['old', undefined],
    ])
  })
  it('does not advance history on failure or duplicate concurrent scroll loads', async () => {
    let reject!: (error: Error) => void
    const turnItems = vi
      .fn()
      .mockResolvedValueOnce(page(['b', 'a'], true))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail
          })
      )
      .mockResolvedValue(page(['z']))
    const { model } = setup({ turnItems })
    await model.connect()
    const loading = model.older()
    await model.older()
    expect(turnItems).toHaveBeenCalledTimes(2)
    reject(new Error('unavailable'))
    await loading
    expect(model.getSnapshot().items.map((x) => x.id)).toEqual(['a', 'b'])
    await model.retryHistory()
    expect(turnItems.mock.calls[2].slice(0, 4)).toEqual(
      turnItems.mock.calls[1].slice(0, 4)
    )
    expect(model.getSnapshot().items.map((x) => x.id)).toEqual(['z', 'a', 'b'])
  })
  it('discards older results after pause even when the transport ignores cancellation', async () => {
    let resolve!: (value: ReturnType<typeof page>) => void
    const { model } = setup({
      turnItems: vi
        .fn()
        .mockResolvedValueOnce(page(['b', 'a'], true))
        .mockImplementationOnce(
          () =>
            new Promise((done) => {
              resolve = done
            })
        ),
    })
    await model.connect()
    const pending = model.older()
    model.pause()
    resolve(page(['stale']))
    await pending
    expect(model.getSnapshot()).toMatchObject({
      connection: 'paused',
      loadingPage: false,
    })
    expect(model.getSnapshot().items.map((x) => x.id)).toEqual(['a', 'b'])
  })
  it('connects an empty session without requesting items', async () => {
    const { model, transport } = setup({
      turns: async () => ({ data: [], last_id: null, has_more: false }),
    })
    await model.connect()
    expect(model.getSnapshot()).toMatchObject({
      connection: 'live',
      items: [],
      hasOlder: false,
    })
    expect(transport.turnItems).not.toHaveBeenCalled()
  })
  it('recovers early items in a long new turn without reconnecting or duplicating streamed output', async () => {
    vi.useFakeTimers()
    const turnItems = vi.fn(async (_id, turn, _limit, after) =>
      turn === 'root'
        ? page(['b', 'a'])
        : after
          ? page(['prompt'])
          : page(['answer', 'tool'], true)
    )
    const { model, transport } = setup({ turnItems })
    await model.connect()
    model.applyEvent({
      type: 'agent.session.turn.in_progress',
      turn: {
        id: 'next',
        status: 'in_progress',
        subagent_id: null,
        created_at: 2,
      },
    })
    model.applyEvent({
      type: 'agent.session.turn.item.added',
      turn_id: 'next',
      item: item('answer'),
    })
    model.applyEvent({
      type: 'agent.session.turn.completed',
      turn: {
        id: 'next',
        status: 'completed',
        subagent_id: null,
        created_at: 2,
      },
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(model.getSnapshot().items.map((x) => x.id)).toEqual([
      'a',
      'b',
      'prompt',
      'tool',
      'answer',
    ])
    expect(turnItems).toHaveBeenLastCalledWith(
      'sess_test',
      'next',
      2,
      'tool',
      expect.any(AbortSignal)
    )
    expect(transport.stream).toHaveBeenCalledTimes(1)
  })
  it('rejects a cyclic turn cursor instead of repeatedly requesting the same page', async () => {
    const { model } = setup({
      turns: async () => ({
        data: [{ id: 'child', subagent_id: 'sub' }],
        last_id: 'child',
        has_more: true,
      }),
    })
    await model.connect()
    expect(model.getSnapshot().historyError).toContain('pagination cursor')
    expect(model.getSnapshot().connection).toBe('live')
  })
  it('reconciles a streamed partial with final saved output when history is retried', async () => {
    const { model } = setup({
      turnItems: vi
        .fn()
        .mockRejectedValueOnce(new Error('500'))
        .mockResolvedValue(page(['answer'])),
    })
    await model.connect()
    model.applyEvent({
      type: 'agent.session.turn.output_text.delta',
      item_id: 'answer',
      content_index: 0,
      output_index: 0,
      delta: 'partial',
    })
    await model.retryHistory()
    expect(model.getSnapshot().items).toHaveLength(1)
    expect(model.getSnapshot().items[0]).toMatchObject({
      id: 'answer',
      status: 'completed',
      content: [{ type: 'output_text', text: 'answer' }],
    })
  })
})
