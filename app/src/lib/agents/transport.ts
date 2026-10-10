import type {
  AgentEvent,
  AgentItem,
  AgentObject,
  AgentPage,
  AgentSession,
  AgentTransport,
} from './types'

export type AgentConnectionOptions = {
  baseUrl: string
  getHeaders?: () => HeadersInit | Promise<HeadersInit>
}

/** Decode SSE incrementally, including CRLF, multiline data and split UTF-8. */
export async function* readAgentEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<AgentEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let data: string[] = []
  let eventBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      pending += decoder.decode(chunk.value, { stream: !chunk.done })
      if (pending.length + eventBytes > 2 * 1024 * 1024)
        throw new Error('Agent event exceeds the 2 MiB limit.')
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '')
          data.push(value)
          eventBytes += value.length
        } else if (!line && data.length) {
          const payload = data.join('\n')
          data = []
          eventBytes = 0
          if (payload === '[DONE]') return
          const event = JSON.parse(payload)
          if (!event || typeof event.type !== 'string')
            throw new Error('Malformed agent event.')
          yield event as AgentEvent
        }
      }
      if (chunk.done) return
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** REST/SSE transport. Secrets remain in the caller's header provider. */
export function createAgentTransport(
  options: AgentConnectionOptions
): AgentTransport {
  const base = new URL(
    options.baseUrl,
    typeof location === 'undefined' ? 'http://localhost' : location.origin
  )
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      'Agents baseUrl must be an HTTP(S) API root without credentials, query, or fragment.'
    )
  }
  const root = base.href.replace(/\/$/, '')
  const request = async (
    path: string,
    signal: AbortSignal,
    stream = false,
    submission?: { body: AgentObject; id?: string }
  ) => {
    const headers = new Headers(await options.getHeaders?.())
    headers.set('OpenAI-Beta', 'agents=v1')
    headers.set('Accept', stream ? 'text/event-stream' : 'application/json')
    if (submission) {
      headers.set('Content-Type', 'application/json')
      if (submission.id) headers.set('Idempotency-Key', submission.id)
    }
    const response = await fetch(
      `${root}/agents/sessions${path ? `/${path}` : ''}`,
      {
        method: submission ? 'POST' : 'GET',
        body: submission ? JSON.stringify(submission.body) : undefined,
        headers,
        signal,
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      }
    )
    // Do not echo upstream response bodies: gateways can include credentials.
    if (!response.ok)
      throw new Error(
        `Agents API returned HTTP ${response.status}. Check access and connection configuration.`
      )
    return response
  }
  const json = async <T>(path: string, signal: AbortSignal): Promise<T> =>
    (await request(path, signal)).json()
  return {
    // A timeout can still leave a created session; never retry this POST automatically.
    createSession: async (parameters, signal) => {
      const response = await request('', signal, false, { body: parameters })
      const session = await response.json().catch(() => null)
      if (!session || typeof session.id !== 'string' || !session.id.trim())
        throw new Error(
          'Invalid session response. Check existing sessions before retrying creation.'
        )
      return session as AgentSession
    },
    sendMessage: async (id, text, submissionId, signal) => {
      await request(`${encodeURIComponent(id)}/events`, signal, false, {
        body: {
          events: [
            {
              type: 'agent.session.input.message',
              input: [
                { role: 'user', content: [{ type: 'input_text', text }] },
              ],
            },
          ],
        },
        id: submissionId,
      })
    },
    session: (id, signal) => json<AgentObject>(encodeURIComponent(id), signal),
    items: (id, limit, after, signal) => {
      const query = new URLSearchParams({ order: 'desc', limit: String(limit) })
      if (after) query.set('after', after)
      return json<AgentPage<AgentItem>>(
        `${encodeURIComponent(id)}/items?${query}`,
        signal
      )
    },
    turns: (id, signal) =>
      json<AgentPage<AgentObject>>(
        `${encodeURIComponent(id)}/turns?order=desc&limit=100`,
        signal
      ),
    stream: async (id, signal) => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      try {
        const response = await request(
          `${encodeURIComponent(id)}/events?stream=true`,
          controller.signal,
          true
        )
        if (
          !response.body ||
          !response.headers.get('content-type')?.includes('text/event-stream')
        ) {
          throw new Error('Agents endpoint did not return an event stream.')
        }
        return {
          events: readAgentEvents(response.body),
          close: () => {
            signal.removeEventListener('abort', abort)
            controller.abort()
          },
        }
      } catch (error) {
        signal.removeEventListener('abort', abort)
        controller.abort()
        throw error
      }
    },
  }
}
