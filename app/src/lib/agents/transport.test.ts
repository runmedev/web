import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAgentTransport, readAgentEvents } from './transport'

afterEach(() => vi.unstubAllGlobals())
describe('agent transport', () => {
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
})
