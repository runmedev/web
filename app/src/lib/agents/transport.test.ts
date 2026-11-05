import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAgentTransport, readAgentEvents } from './transport'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
describe('agent transport', () => {
  it('encodes saved agent IDs, does not retry updates, and suppresses upstream error bodies', async () => {
    const fetch = vi.fn(
      async () => new Response('secret diagnostic', { status: 403 })
    )
    vi.stubGlobal('fetch', fetch)
    const api = createAgentTransport({ baseUrl: 'https://api.openai.com/v1' })
    await expect(
      api.updateAgent(
        'agent_a/b',
        { instructions: 'Act carefully.' },
        new AbortController().signal
      )
    ).rejects.toThrow(
      'Agents API returned HTTP 403. Check access and connection configuration.'
    )
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe(
      'https://api.openai.com/v1/agents/agent_a%2Fb'
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['{"id":"agent_other"}', '{}', 'null', 'secret invalid JSON'])(
    'rejects an invalid update response without exposing its body: %s',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body))
      )
      const api = createAgentTransport({ baseUrl: 'https://api.openai.com/v1' })
      await expect(
        api.updateAgent(
          'agent_test',
          { instructions: 'Act carefully.' },
          new AbortController().signal
        )
      ).rejects.toThrow(
        /^Invalid agent update response\. Check saved settings before retrying\.$/
      )
    }
  )
  it('preserves cancellation while reading an update response body', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Cancelled by caller', 'AbortError')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          controller.abort(reason)
          throw reason
        },
      }))
    )
    const api = createAgentTransport({ baseUrl: 'https://api.openai.com/v1' })
    await expect(
      api.updateAgent(
        'agent_test',
        { instructions: 'Act carefully.' },
        controller.signal
      )
    ).rejects.toBe(reason)
  })
  it('creates a session at the collection endpoint and preserves its executor URL', async () => {
    const session = {
      id: 'sess_new',
      environment: {
        id: 'env_new',
        remote_url: 'https://api.openai.com/v1/remote/path?route=1',
      },
    }
    const fetch = vi.fn(
      async () => new Response(JSON.stringify(session), { status: 201 })
    )
    vi.stubGlobal('fetch', fetch)
    const api = createAgentTransport({
      baseUrl: 'https://api.openai.com/v1/',
      getHeaders: () => ({ Authorization: 'Bearer test-secret' }),
    })
    const parameters = {
      agent_id: 'agent_test',
      environment: { type: 'self_hosted', workspace_directory: '/workspace' },
    }
    const signal = new AbortController().signal
    expect(await api.createSession(parameters, signal)).toEqual(session)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/agents/sessions')
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify(parameters),
      signal,
      redirect: 'error',
      cache: 'no-store',
    })
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer test-secret'
    )
    expect(new Headers(init.headers).get('OpenAI-Beta')).toBe('agents=v1')
    expect(new Headers(init.headers).get('Content-Type')).toBe(
      'application/json'
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('does not retry ambiguous creation failures or expose error bodies', async () => {
    const fetch = vi.fn(
      async () => new Response('secret upstream diagnostic', { status: 503 })
    )
    vi.stubGlobal('fetch', fetch)
    const api = createAgentTransport({ baseUrl: 'https://api.openai.com/v1' })
    await expect(
      api.createSession({}, new AbortController().signal)
    ).rejects.toThrow(/^Agents API returned HTTP 503/)
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
    await expect(
      api.createSession({}, new AbortController().signal)
    ).rejects.toThrow('Timed out')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each(['{}', 'not-json', '{"id": ""}'])(
    'rejects malformed creation response %s',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body))
      )
      const api = createAgentTransport({ baseUrl: 'https://api.openai.com/v1' })
      await expect(
        api.createSession({}, new AbortController().signal)
      ).rejects.toThrow('Check existing sessions')
    }
  )
  it('posts user text to session events with fresh auth and a stable idempotency header', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const getHeaders = vi.fn(() => ({ Authorization: 'Bearer test-secret' }))
    const api = createAgentTransport({
      baseUrl: 'https://api.openai.com/v1',
      getHeaders,
    })
    await api.sendMessage(
      'sess/1',
      'hello\nworld',
      'submission-1',
      new AbortController().signal
    )
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      'https://api.openai.com/v1/agents/sessions/sess%2F1/events'
    )
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe(
      'submission-1'
    )
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer test-secret'
    )
    expect(JSON.parse(init.body as string)).toEqual({
      events: [
        {
          type: 'agent.session.input.message',
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: 'hello\nworld' }],
            },
          ],
        },
      ],
    })
  })
  it('decodes split UTF-8, CRLF, comments and multiline SSE data', async () => {
    const bytes = new TextEncoder().encode(
      ': heartbeat\r\ndata: {"type":"test",\r\ndata: "text":"👋"}\r\n\r\ndata: [DONE]\n\n'
    )
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })
    const events = []
    for await (const event of readAgentEvents(stream)) events.push(event)
    expect(events).toEqual([{ type: 'test', text: '👋' }])
  })
  it('requests bounded descending pages with encoded cursors and refreshed headers', async () => {
    const fetch = vi.fn<
      (url: string, options?: RequestInit) => Promise<Response>
    >(async () => new Response(JSON.stringify({ data: [] })))
    vi.stubGlobal('fetch', fetch)
    const getHeaders = vi.fn(() => ({ Authorization: 'Bearer secret' }))
    const api = createAgentTransport({
      baseUrl: 'https://api.openai.com/v1',
      getHeaders,
    })
    const signal = new AbortController().signal
    await api.items('sess/1', 50, 'a&b', signal)
    await api.session('sess/1', signal)
    expect(fetch.mock.calls[0][0]).toBe(
      'https://api.openai.com/v1/agents/sessions/sess%2F1/items?order=desc&limit=50&after=a%26b'
    )
    expect(getHeaders).toHaveBeenCalledTimes(2)
  })
  it('does not reflect secret-bearing error bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Authorization: secret', { status: 401 }))
    )
    await expect(
      createAgentTransport({ baseUrl: 'https://api.openai.com/v1' }).session(
        's',
        new AbortController().signal
      )
    ).rejects.toThrow('HTTP 401')
  })
  it('uses per-turn items and paginates the turn collection with encoded IDs', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [], has_more: false, last_id: null })
        )
    )
    vi.stubGlobal('fetch', fetch)
    const api = createAgentTransport({ baseUrl: 'https://api.openai.com/v1' })
    const signal = new AbortController().signal
    await api.turnItems('sess/1', 'turn/2', 25, 'item&3', signal)
    await api.turns('sess/1', signal, 'turn&4')
    expect(
      (fetch.mock.calls as unknown as [string][]).map((call) => call[0])
    ).toEqual([
      'https://api.openai.com/v1/agents/sessions/sess%2F1/turns/turn%2F2/items?order=desc&limit=25&after=item%263',
      'https://api.openai.com/v1/agents/sessions/sess%2F1/turns?order=desc&limit=100&after=turn%264',
    ])
  })
  it('retries a transient read only once and exposes its request ID, never its body', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(
      async () =>
        new Response('secret diagnostic', {
          status: 500,
          headers: { 'x-request-id': 'req_fixture' },
        })
    )
    vi.stubGlobal('fetch', fetch)
    const api = createAgentTransport({ baseUrl: 'https://api.openai.com/v1' })
    const pending = expect(
      api.turnItems('s', 't', 1, undefined, new AbortController().signal)
    ).rejects.toThrow(
      'HTTP 500. Check access and connection configuration. Request ID: req_fixture'
    )
    await vi.advanceTimersByTimeAsync(500)
    await pending
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('cancels read retry backoff immediately on pause', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const api = createAgentTransport({ baseUrl: 'https://api.openai.com/v1' })
    const controller = new AbortController()
    const pending = expect(api.session('s', controller.signal)).rejects.toThrow(
      'paused'
    )
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(new Error('paused'))
    await pending
    await vi.advanceTimersByTimeAsync(500)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('bounds reads including response bodies by a per-attempt deadline', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn((_url: string, options: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) =>
            options.signal!.addEventListener(
              'abort',
              () => reject(options.signal!.reason),
              { once: true }
            )
          ),
      })
    )
    vi.stubGlobal('fetch', fetch)
    const api = createAgentTransport({ baseUrl: 'https://api.openai.com/v1' })
    const pending = expect(
      api.session('s', new AbortController().signal)
    ).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(40_500)
    await pending
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
