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
    createSession: vi.fn(async () => ({ id: 'sess_test' })),
    sendMessage: vi.fn(async () => {}),
    session: vi.fn(async () => ({ status: 'idle' })),
    items: vi.fn(async () => page(['b', 'a'], true)),
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
  it('defers scheduled refreshes until an in-flight message submission settles', async () => {
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
    expect(transport.stream).toHaveBeenCalledTimes(2)
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
    expect(model.getSnapshot().items[1].content?.[0].text).toBe('b')
    expect(model.getSnapshot().turn?.status).toBe('completed')
  })
  it('loads one descending page, renders chronologically and does not confuse idle with success', async () => {
    const { model, transport } = setup({
      turns: async () => ({ data: [], has_more: false, last_id: null }),
    })
    await model.connect()
    expect(transport.items).toHaveBeenCalledWith(
      'sess_test',
      2,
      undefined,
      expect.any(AbortSignal)
    )
    expect(model.getSnapshot().items.map((x) => x.id)).toEqual(['a', 'b'])
    expect(model.getSnapshot().turn).toBeNull()
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
    expect(model.getSnapshot().items[1].content?.[0].text).toBe('partial')
    model.applyEvent({
      ...delta,
      type: 'agent.session.turn.output_text.done',
      event_id: 'done',
      text: '**complete**',
    })
    model.applyEvent({ ...delta, event_id: 'late' })
    expect(model.getSnapshot().items[1].content?.[0].text).toBe('**complete**')
    model.applyEvent({
      ...delta,
      type: 'agent.session.turn.output_text.done',
      event_id: 'other',
      item_id: 'd',
      text: 'No deltas',
    })
    expect(model.getSnapshot().items[1].content?.[0].text).toBe('No deltas')
  })
  it('keeps historical items fixed while live activity arrives and uses server cursors', async () => {
    const { model, transport } = setup({
      items: vi.fn(async (_id, _limit, after) =>
        after ? page(['old2', 'old1']) : page(['b', 'a'], true)
      ),
    })
    await model.connect()
    await model.older()
    model.applyEvent({ type: 'agent.session.turn.item.added', item: item('c') })
    expect(model.getSnapshot().items.map((x) => x.id)).toEqual(['old1', 'old2'])
    expect(model.getSnapshot().newActivity).toBe(1)
    expect(transport.items).toHaveBeenLastCalledWith(
      'sess_test',
      2,
      'a',
      expect.any(AbortSignal)
    )
    model.latest()
    expect(model.getSnapshot().items.map((x) => x.id)).toEqual(['b', 'c'])
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
      items: () =>
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
    expect(model.getSnapshot().items[1].content?.[0].text).toBe('b')
  })
  it('does not revive a monitor after pause during hydration', async () => {
    let resolvePage!: (value: ReturnType<typeof page>) => void
    const { model, close } = setup({
      items: () =>
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
      items: async () => ({ ...page(['b', 'a'], true), last_id: null }),
    })
    await model.connect()
    await model.older()
    expect(model.getSnapshot().error).toContain('pagination cursor')
  })
  it('caps activity and live items and preserves legacy null IDs', async () => {
    const { model } = setup({
      items: async () => ({
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
})
