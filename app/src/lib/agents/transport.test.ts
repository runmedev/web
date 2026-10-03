import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAgentTransport, readAgentEvents } from './transport'

afterEach(() => vi.unstubAllGlobals())
describe('agent transport', () => {
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
    const fetch = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ data: [] }))
    )
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
