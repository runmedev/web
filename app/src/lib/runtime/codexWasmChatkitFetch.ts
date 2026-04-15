import { appLogger } from '../logging/runtime'
import type { CodeModeExecutor } from './codeModeExecutor'
import { createCodexWasmSession } from './codexWasmSession'
import type { ChatKitThreadDetail } from './chatkitProtocol'

type JsonRecord = Record<string, unknown>

type BodyPayload = {
  raw: unknown
  json: JsonRecord
}

type StoredThread = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  previousResponseId?: string
  items: JsonRecord[]
}

function randomId(prefix: string): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return `${prefix}_${crypto.randomUUID()}`
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as JsonRecord
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined
}

async function resolveBody(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<BodyInit | null | undefined> {
  if (init?.body != null) {
    return init.body
  }
  if (!(input instanceof Request)) {
    return init?.body
  }
  const clone = input.clone()
  const contentType = clone.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('multipart/form-data')) {
    try {
      return await clone.formData()
    } catch {
      return null
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    try {
      return new URLSearchParams(await clone.text())
    } catch {
      return null
    }
  }
  try {
    return await clone.text()
  } catch {
    return null
  }
}

async function readBody(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<BodyPayload> {
  const body = await resolveBody(input, init)
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as JsonRecord
      return { raw: parsed, json: parsed }
    } catch {
      return { raw: body, json: {} }
    }
  }
  if (body instanceof FormData) {
    const json: JsonRecord = {}
    body.forEach((value, key) => {
      if (typeof value === 'string') {
        try {
          json[key] = JSON.parse(value)
        } catch {
          json[key] = value
        }
      }
    })
    return { raw: json, json }
  }
  if (body instanceof URLSearchParams) {
    const json: JsonRecord = {}
    body.forEach((value, key) => {
      json[key] = value
    })
    return { raw: json, json }
  }
  return { raw: null, json: {} }
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  })
}

function getPayloadRecord(payload: JsonRecord): JsonRecord {
  const params =
    payload.params &&
    typeof payload.params === 'object' &&
    !Array.isArray(payload.params)
      ? (payload.params as JsonRecord)
      : null
  return params ?? payload
}

function extractInput(payload: JsonRecord): { text: string } {
  const root = getPayloadRecord(payload)
  const input = asRecord(root.input)
  const content = Array.isArray(input.content) ? input.content : []
  const text = content
    .map((entry) => {
      const part = asRecord(entry)
      return asString(part.text) ?? ''
    })
    .join('')
    .trim()
  return { text }
}

function readThreadId(payload: JsonRecord): string | undefined {
  const root = getPayloadRecord(payload)
  return (
    asString(root.thread_id) ??
    asString(root.threadId) ??
    asString(asRecord(root.thread).id)
  )
}

function buildThreadDetail(thread: StoredThread): ChatKitThreadDetail {
  return {
    id: thread.id,
    title: thread.title,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    status: { type: 'active' },
    metadata: {},
    items: {
      data: thread.items,
      has_more: false,
    },
    messages: {
      data: thread.items.filter((item) => {
        const type = asString(asRecord(item).type)
        return type === 'assistant_message' || type === 'user_message'
      }),
      has_more: false,
    },
  }
}

function buildStreamResponse(
  producer: (sink: { emit: (payload: unknown) => void }) => Promise<void>,
  options?: {
    signal?: AbortSignal | null
    logContext?: Record<string, unknown>
  }
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const emit = (payload: unknown) => {
        if (closed) {
          return
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      }

      void producer({ emit })
        .catch((error) => {
          appLogger.error('Codex WASM ChatKit stream failed', {
            attrs: {
              scope: 'chatkit.codex_wasm',
              error: String(error),
              ...options?.logContext,
            },
          })
          emit({
            type: 'response.failed',
            error: {
              message: String(error),
            },
          })
        })
        .finally(() => {
          if (closed) {
            return
          }
          closed = true
          controller.close()
        })

      options?.signal?.addEventListener(
        'abort',
        () => {
          if (closed) {
            return
          }
          closed = true
          controller.close()
        },
        { once: true }
      )
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
}

function withUpdatedThreadTitle(thread: StoredThread, text: string): void {
  const trimmed = text.trim()
  if (!trimmed || thread.title !== 'New conversation') {
    return
  }
  thread.title = trimmed.slice(0, 80)
}

export function createCodexWasmChatkitFetch(options: {
  codeModeExecutor: CodeModeExecutor
}): typeof fetch {
  const threads = new Map<string, StoredThread>()
  const session = createCodexWasmSession({
    codeModeExecutor: options.codeModeExecutor,
  })

  const ensureThread = (threadId?: string): StoredThread => {
    const normalized = threadId?.trim() ?? ''
    if (normalized && threads.has(normalized)) {
      return threads.get(normalized)!
    }
    const now = new Date().toISOString()
    const created: StoredThread = {
      id: normalized || randomId('thread'),
      title: 'New conversation',
      createdAt: now,
      updatedAt: now,
      items: [],
    }
    threads.set(created.id, created)
    return created
  }

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const { json } = await readBody(input, init)
    const requestType =
      asString(getPayloadRecord(json).type) ?? asString(json.type) ?? ''

    if (requestType === 'threads.list') {
      return jsonResponse({
        data: [...threads.values()].map((thread) => ({
          id: thread.id,
          title: thread.title,
          updated_at: thread.updatedAt,
        })),
        has_more: false,
      })
    }

    if (requestType === 'threads.get_by_id' || requestType === 'threads.get') {
      const threadId = readThreadId(json)
      const thread = threadId ? threads.get(threadId) : undefined
      if (!thread) {
        return new Response(JSON.stringify({ error: 'thread_not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      return jsonResponse(buildThreadDetail(thread))
    }

    if (requestType === 'items.list' || requestType === 'messages.list') {
      const threadId = readThreadId(json)
      const thread = threadId ? threads.get(threadId) : undefined
      return jsonResponse({
        data: thread?.items ?? [],
        has_more: false,
      })
    }

    if (
      requestType === 'threads.create' ||
      requestType === 'threads.add_user_message'
    ) {
      const { text } = extractInput(json)
      if (!text) {
        return jsonResponse({
          data: null,
          error: 'missing_user_input',
        })
      }

      const requestedThreadId =
        requestType === 'threads.add_user_message'
          ? readThreadId(json)
          : undefined
      const thread = ensureThread(requestedThreadId)
      withUpdatedThreadTitle(thread, text)

      const userItem: JsonRecord = {
        id: randomId('msg'),
        type: 'user_message',
        thread_id: thread.id,
        created_at: new Date().toISOString(),
        content: [
          {
            type: 'input_text',
            text,
          },
        ],
        attachments: [],
        inference_options: {},
      }
      thread.items.push(userItem)
      thread.updatedAt = new Date().toISOString()

      return buildStreamResponse(
        async (sink) => {
          if (requestType === 'threads.create') {
            sink.emit({
              type: 'thread.created',
              thread: {
                id: thread.id,
                title: thread.title,
                created_at: thread.createdAt,
              },
            })
          }
          sink.emit({
            type: 'thread.item.added',
            item: userItem,
          })
          sink.emit({
            type: 'thread.item.done',
            item: userItem,
          })

          let assistantItemId = ''
          let assistantText = ''
          let assistantCreatedAt = new Date().toISOString()
          let failureMessage = ''

          const ensureAssistantItem = () => {
            if (assistantItemId) {
              return assistantItemId
            }
            assistantItemId = randomId('assistant')
            assistantCreatedAt = new Date().toISOString()
            sink.emit({
              type: 'thread.item.added',
              item: {
                id: assistantItemId,
                type: 'assistant_message',
                thread_id: thread.id,
                created_at: assistantCreatedAt,
                status: 'in_progress',
                content: [],
              },
            })
            sink.emit({
              type: 'thread.item.updated',
              item_id: assistantItemId,
              update: {
                type: 'assistant_message.content_part.added',
                content_index: 0,
                content: {
                  type: 'output_text',
                  text: '',
                  annotations: [],
                },
              },
            })
            return assistantItemId
          }

          const finalizeAssistant = (finalText: string) => {
            const normalized = finalText.trim() ? finalText : assistantText
            if (!normalized && !assistantItemId) {
              return
            }
            const itemId = ensureAssistantItem()
            sink.emit({
              type: 'thread.item.updated',
              item_id: itemId,
              update: {
                type: 'assistant_message.content_part.done',
                content_index: 0,
                content: {
                  type: 'output_text',
                  text: normalized,
                  annotations: [],
                },
              },
            })
            const assistantItem: JsonRecord = {
              id: itemId,
              type: 'assistant_message',
              thread_id: thread.id,
              created_at: assistantCreatedAt,
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: normalized,
                  annotations: [],
                },
              ],
            }
            thread.items.push(assistantItem)
            thread.updatedAt = new Date().toISOString()
            sink.emit({
              type: 'thread.item.done',
              item: assistantItem,
            })
          }

          const submissionId = await session.submitTurn({
            prompt: text,
            onEvent: (event) => {
              const root = asRecord(event)
              const msg = asRecord(root.msg)
              const msgType = asString(msg.type)
              switch (msgType) {
                case 'session_configured':
                  return
                case 'task_started':
                case 'turn_started':
                  ensureAssistantItem()
                  return
                case 'agent_message_delta': {
                  const delta = asString(msg.delta) ?? ''
                  if (!delta) {
                    return
                  }
                  const itemId = ensureAssistantItem()
                  assistantText = `${assistantText}${delta}`
                  sink.emit({
                    type: 'thread.item.updated',
                    item_id: itemId,
                    update: {
                      type: 'assistant_message.content_part.text_delta',
                      content_index: 0,
                      delta,
                    },
                  })
                  return
                }
                case 'agent_message': {
                  const message = asString(msg.message) ?? ''
                  if (message && !assistantText) {
                    assistantText = message
                  }
                  return
                }
                case 'error':
                  failureMessage = asString(msg.message) ?? 'Codex WASM turn failed'
                  return
                case 'task_complete':
                case 'turn_complete':
                  finalizeAssistant(asString(msg.last_agent_message) ?? '')
                  return
                default:
                  return
              }
            },
          })

          thread.previousResponseId = submissionId
          thread.updatedAt = new Date().toISOString()
          sink.emit({
            type: 'aisre.chatkit.state',
            item: {
              state: {
                threadId: thread.id,
                previousResponseId: submissionId,
              },
            },
          })

          if (failureMessage) {
            sink.emit({
              type: 'response.failed',
              error: {
                message: failureMessage,
              },
            })
            return
          }

          const endOfTurn: JsonRecord = {
            id: randomId('end'),
            type: 'end_of_turn',
            thread_id: thread.id,
            created_at: new Date().toISOString(),
          }
          thread.items.push(endOfTurn)
          thread.updatedAt = new Date().toISOString()
          sink.emit({
            type: 'thread.item.done',
            item: endOfTurn,
          })
          sink.emit({
            type: 'response.completed',
            response: { id: submissionId || randomId('resp') },
          })
        },
        { signal: init?.signal ?? null }
      )
    }

    if (requestType === 'threads.add_client_tool_output') {
      return jsonResponse({
        data: null,
        error: 'client_tool_output_not_supported_for_codex_wasm',
      })
    }

    return jsonResponse({
      data: null,
      error: requestType
        ? `unsupported_request_type:${requestType}`
        : 'unsupported_request',
    })
  }
}
