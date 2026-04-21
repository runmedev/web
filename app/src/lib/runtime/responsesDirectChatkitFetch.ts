import { getAccessToken } from '../../token'
import { appLogger } from '../logging/runtime'
import type { ChatKitThreadDetail } from './chatkitProtocol'
import { createChatKitFetchFromAdapter } from './createChatKitFetchFromAdapter'
import type {
  HarnessChatKitAdapter,
  HarnessChatKitEventSink,
  HarnessChatKitMessageRequest,
  HarnessChatKitToolResultRequest,
} from './harnessChatKitAdapter'
import { responsesDirectConfigManager } from './responsesDirectConfigManager'
import { RUNME_RESPONSES_DIRECT_INSTRUCTIONS } from './runmeChatkitPrompts'

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
  model: string
  items: JsonRecord[]
}

const DEFAULT_OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = 'gpt-5.2'
const EXECUTE_CODE_TOOL_NAME = 'ExecuteCode'

function buildCodeModeToolDefinition(): JsonRecord {
  return {
    type: 'function',
    name: EXECUTE_CODE_TOOL_NAME,
    description:
      'Execute JavaScript in AppKernel and return one merged stdout/stderr output string.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: {
          type: 'string',
        },
      },
      required: ['code'],
    },
  }
}

function buildResponsesTools(vectorStores: string[]): JsonRecord[] {
  const tools: JsonRecord[] = [buildCodeModeToolDefinition()]
  if (vectorStores.length > 0) {
    tools.push({
      type: 'file_search',
      max_num_results: 5,
      vector_store_ids: vectorStores,
    })
  }
  return tools
}

function resolveResponsesApiUrl(responsesApiBaseUrl: string): string {
  const normalized = responsesApiBaseUrl.trim().replace(/\/+$/, '')
  if (!normalized) {
    return DEFAULT_OPENAI_RESPONSES_URL
  }
  try {
    const url = new URL(normalized)
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/v1/responses'
      url.search = ''
      url.hash = ''
    }
    return url.toString()
  } catch (error) {
    appLogger.warn(
      'Invalid responses-direct baseUrl override; using OpenAI default',
      {
        attrs: {
          scope: 'chatkit.responses_direct',
          baseUrl: normalized,
          error: String(error),
        },
      }
    )
    return DEFAULT_OPENAI_RESPONSES_URL
  }
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

function randomId(prefix: string): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return `${prefix}_${crypto.randomUUID()}`
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`
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

function extractInput(payload: JsonRecord): {
  text: string
  model: string
} {
  const source = getPayloadRecord(payload)
  const inputRecord = asRecord(source.input)
  const content = Array.isArray(inputRecord.content) ? inputRecord.content : []
  const text = content
    .map((item) => {
      const part = asRecord(item)
      return asString(part.text) ?? asString(part.value) ?? ''
    })
    .join('')
    .trim()
  const inference = asRecord(inputRecord.inference_options)
  const model = asString(inference.model) ?? DEFAULT_MODEL
  return { text, model }
}

function toOutputString(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value == null) {
    return ''
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function extractToolOutput(payload: JsonRecord): {
  callId: string
  previousResponseId: string
  output: string
} {
  const source = getPayloadRecord(payload)
  const result = asRecord(source.result)
  const callId = asString(result.callId) ?? asString(result.call_id) ?? ''
  const previousResponseId =
    asString(result.previousResponseId) ??
    asString(result.previous_response_id) ??
    ''
  const clientError =
    asString(result.clientError) ?? asString(result.client_error) ?? ''
  const outputValue = result.output ?? result.result
  const outputText = toOutputString(outputValue)
  const output =
    clientError.length > 0
      ? [outputText, `Tool execution failed: ${clientError}`]
          .filter((part) => part.length > 0)
          .join('\n')
      : outputText
  return { callId, previousResponseId, output }
}

function readThreadId(payload: JsonRecord): string {
  const source = getPayloadRecord(payload)
  return (
    asString(source.id) ??
    asString(source.thread_id) ??
    asString(source.threadId) ??
    asString(payload.id) ??
    asString(payload.thread_id) ??
    asString(payload.threadId) ??
    ''
  )
}

function buildThreadDetail(thread: StoredThread): ChatKitThreadDetail {
  const messages = {
    data: thread.items,
    has_more: false,
  }
  return {
    id: thread.id,
    title: thread.title,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    status: { type: 'active' },
    metadata: {},
    items: messages,
    messages,
  }
}

function withUpdatedThreadTitle(thread: StoredThread, text: string): void {
  if (thread.title !== 'New conversation') {
    return
  }
  const trimmed = text.trim()
  if (!trimmed) {
    return
  }
  const shortened = trimmed.slice(0, 80)
  thread.title = shortened
}

async function resolveResponsesDirectHeaders(): Promise<Headers> {
  const config = responsesDirectConfigManager.getSnapshot()
  const headers = new Headers({
    'content-type': 'application/json',
  })

  if (config.authMethod === 'api_key') {
    const apiKey = config.apiKey.trim()
    if (!apiKey) {
      throw new Error(
        'Direct Responses API key auth selected but no key is configured. Run app.responsesDirect.setAPIKey(...).'
      )
    }
    headers.set('Authorization', `Bearer ${apiKey}`)
    return headers
  }

  const oauthToken = (await getAccessToken()).trim()
  if (!oauthToken) {
    throw new Error('Direct Responses OAuth requires ChatGPT sign-in.')
  }
  if (!config.openaiOrganization) {
    throw new Error(
      'Direct Responses OAuth requires OpenAI organization. Set agent.openai.organization in app-configs.yaml or use app.responsesDirect.setOpenAIOrganization(...).'
    )
  }
  if (!config.openaiProject) {
    throw new Error(
      'Direct Responses OAuth requires OpenAI project. Set agent.openai.project in app-configs.yaml or use app.responsesDirect.setOpenAIProject(...).'
    )
  }

  headers.set('Authorization', `Bearer ${oauthToken}`)
  headers.set('OpenAI-Organization', config.openaiOrganization)
  headers.set('OpenAI-Project', config.openaiProject)
  return headers
}

function buildOpenAIResponsesRequestForInput(options: {
  text: string
  model: string
  previousResponseId?: string
  vectorStores: string[]
}): JsonRecord {
  const payload: JsonRecord = {
    model: options.model || DEFAULT_MODEL,
    stream: true,
    instructions: RUNME_RESPONSES_DIRECT_INSTRUCTIONS,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: options.text,
          },
        ],
      },
    ],
    parallel_tool_calls: false,
  }

  if (options.previousResponseId) {
    payload.previous_response_id = options.previousResponseId
  }

  payload.tools = buildResponsesTools(options.vectorStores)

  return payload
}

function buildOpenAIResponsesRequestForToolOutput(options: {
  callId: string
  output: string
  model: string
  previousResponseId?: string
  vectorStores: string[]
}): JsonRecord {
  const payload: JsonRecord = {
    model: options.model || DEFAULT_MODEL,
    stream: true,
    instructions: RUNME_RESPONSES_DIRECT_INSTRUCTIONS,
    input: [
      {
        type: 'function_call_output',
        call_id: options.callId,
        output: options.output,
      },
    ],
    parallel_tool_calls: false,
  }

  if (options.previousResponseId) {
    payload.previous_response_id = options.previousResponseId
  }

  payload.tools = buildResponsesTools(options.vectorStores)

  return payload
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text || `${response.status} ${response.statusText}`
  } catch {
    return `${response.status} ${response.statusText}`
  }
}

async function consumeSSE(
  response: Response,
  onEvent: (event: JsonRecord) => void,
  signal?: AbortSignal | null
): Promise<void> {
  if (!response.body) {
    throw new Error('Responses API returned no stream body')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    if (signal?.aborted) {
      throw new Error(String(signal.reason ?? 'Request aborted'))
    }
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const lines = block.split('\n')
      const dataLines = lines
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.length > 0)
      if (dataLines.length > 0) {
        const data = dataLines.join('\n')
        if (data !== '[DONE]') {
          try {
            onEvent(JSON.parse(data) as JsonRecord)
          } catch (error) {
            appLogger.warn('Failed to parse OpenAI responses SSE event', {
              attrs: {
                scope: 'chatkit.responses_direct',
                error: String(error),
                payload: data,
              },
            })
          }
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

function buildStreamResponse(
  producer: (sink: { emit: (payload: unknown) => void }) => Promise<void>,
  options?: { signal?: AbortSignal | null }
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const emit = (payload: unknown) => {
        if (closed) {
          return
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
        )
      }
      const close = () => {
        if (closed) {
          return
        }
        closed = true
        controller.close()
      }

      if (options?.signal?.aborted) {
        emit({
          type: 'response.failed',
          error: {
            message: String(options.signal.reason ?? 'Request aborted'),
          },
        })
        close()
        return
      }

      if (options?.signal) {
        options.signal.addEventListener(
          'abort',
          () => {
            if (!closed) {
              emit({
                type: 'response.failed',
                error: {
                  message: String(options.signal?.reason ?? 'Request aborted'),
                },
              })
            }
            close()
          },
          { once: true }
        )
      }

      void producer({ emit })
        .catch((error) => {
          emit({
            type: 'response.failed',
            error: { message: String(error) },
          })
          appLogger.error('Direct Responses stream producer failed', {
            attrs: {
              scope: 'chatkit.responses_direct',
              error: String(error),
            },
          })
        })
        .finally(() => {
          close()
        })
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
}

export function createResponsesDirectChatKitAdapter(options?: {
  responsesApiBaseUrl?: string
}): HarnessChatKitAdapter {
  const responsesApiUrl = resolveResponsesApiUrl(
    options?.responsesApiBaseUrl ?? ''
  )
  const threads = new Map<string, StoredThread>()

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
      model: DEFAULT_MODEL,
      items: [],
    }
    threads.set(created.id, created)
    return created
  }

  const streamOpenAI = async (options: {
    thread: StoredThread
    responsesApiUrl: string
    requestPayload: JsonRecord
    emit: (payload: unknown) => void
    signal?: AbortSignal | null
  }): Promise<void> => {
    const headers = await resolveResponsesDirectHeaders()
    const response = await fetch(options.responsesApiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.requestPayload),
      signal: options.signal ?? undefined,
    })
    if (!response.ok) {
      throw new Error(await readErrorBody(response))
    }

    const assistantTextByItem = new Map<string, string>()
    const toolNameByItem = new Map<string, string>()
    const toolCallIdByItem = new Map<string, string>()

    await consumeSSE(
      response,
      (event) => {
        const type = asString(event.type) ?? ''
        if (!type) {
          return
        }
        switch (type) {
          case 'response.created': {
            const responseRecord = asRecord(event.response)
            const responseId = asString(responseRecord.id)
            if (responseId) {
              options.thread.previousResponseId = responseId
              options.thread.updatedAt = new Date().toISOString()
              options.emit({
                type: 'aisre.chatkit.state',
                item: {
                  state: {
                    threadId: options.thread.id,
                    previousResponseId: responseId,
                  },
                },
              })
            }
            return
          }
          case 'response.output_item.added': {
            const item = asRecord(event.item)
            if (asString(item.type) === 'function_call') {
              const itemId = asString(item.id)
              const toolName = asString(item.name)
              const toolCallId = asString(item.call_id)
              if (itemId && toolName) {
                toolNameByItem.set(itemId, toolName)
              }
              if (itemId && toolCallId) {
                toolCallIdByItem.set(itemId, toolCallId)
              }
              return
            }
            if (asString(item.type) !== 'message') {
              return
            }
            const itemId = asString(item.id) ?? randomId('assistant')
            assistantTextByItem.set(itemId, '')
            options.emit({
              type: 'thread.item.added',
              item: {
                id: itemId,
                type: 'assistant_message',
                thread_id: options.thread.id,
                created_at: new Date().toISOString(),
                status: 'in_progress',
                content: [],
              },
            })
            options.emit({
              type: 'thread.item.updated',
              item_id: itemId,
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
            return
          }
          case 'response.output_text.delta': {
            const itemId = asString(event.item_id)
            const delta = asString(event.delta) ?? ''
            if (!itemId || !delta) {
              return
            }
            assistantTextByItem.set(
              itemId,
              `${assistantTextByItem.get(itemId) ?? ''}${delta}`
            )
            options.emit({
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
          case 'response.output_item.done': {
            const item = asRecord(event.item)
            if (asString(item.type) !== 'message') {
              return
            }
            const itemId = asString(item.id) ?? randomId('assistant')
            const parts = Array.isArray(item.content) ? item.content : []
            const textFromDone = parts
              .map((part) => asString(asRecord(part).text) ?? '')
              .join('')
            const finalText =
              textFromDone || assistantTextByItem.get(itemId) || ''
            options.emit({
              type: 'thread.item.updated',
              item_id: itemId,
              update: {
                type: 'assistant_message.content_part.done',
                content_index: 0,
                content: {
                  type: 'output_text',
                  text: finalText,
                  annotations: [],
                },
              },
            })
            const assistantItem: JsonRecord = {
              id: itemId,
              type: 'assistant_message',
              thread_id: options.thread.id,
              created_at: new Date().toISOString(),
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: finalText,
                  annotations: [],
                },
              ],
            }
            options.thread.items.push(assistantItem)
            options.thread.updatedAt = new Date().toISOString()
            return
          }
          case 'response.function_call_arguments.done': {
            const itemId = asString(event.item_id) ?? randomId('tool')
            const fallbackCallId = itemId.startsWith('call_')
              ? itemId
              : undefined
            const callId =
              asString(event.call_id) ??
              asString(asRecord(event.item).call_id) ??
              toolCallIdByItem.get(itemId) ??
              fallbackCallId
            const name =
              asString(event.name) ??
              toolNameByItem.get(itemId) ??
              asString(asRecord(event.item).name) ??
              EXECUTE_CODE_TOOL_NAME
            let argumentsObject: JsonRecord = {}
            const argumentsRaw = asString(event.arguments) ?? '{}'
            try {
              argumentsObject = asRecord(JSON.parse(argumentsRaw))
            } catch {
              argumentsObject = {}
            }
            argumentsObject.call_id = callId
            if (options.thread.previousResponseId) {
              argumentsObject.previous_response_id =
                options.thread.previousResponseId
            }
            const toolItem: JsonRecord = {
              id: itemId,
              type: 'client_tool_call',
              thread_id: options.thread.id,
              created_at: new Date().toISOString(),
              status: 'pending',
              call_id: callId,
              name,
              arguments: argumentsObject,
            }
            options.thread.items.push(toolItem)
            options.thread.updatedAt = new Date().toISOString()
            options.emit({
              type: 'thread.item.done',
              item: toolItem,
            })
            return
          }
          case 'response.completed': {
            const endOfTurn: JsonRecord = {
              id: randomId('end'),
              type: 'end_of_turn',
              thread_id: options.thread.id,
              created_at: new Date().toISOString(),
            }
            options.thread.items.push(endOfTurn)
            options.thread.updatedAt = new Date().toISOString()
            options.emit({
              type: 'thread.item.done',
              item: endOfTurn,
            })
            return
          }
          default:
            return
        }
      },
      options.signal
    )
  }

  return {
    historyEnabled: true,
    async listThreads() {
      return [...threads.values()].map((thread) => ({
        id: thread.id,
        title: thread.title,
        updated_at: thread.updatedAt,
      }))
    },
    async getThread(threadId: string) {
      const thread = threadId ? threads.get(threadId) : undefined
      if (!thread) {
        throw new Error('thread_not_found')
      }
      return buildThreadDetail(thread)
    },
    async listItems(threadId: string) {
      const thread = threadId ? threads.get(threadId) : undefined
      return thread?.items ?? []
    },
    async streamUserMessage(
      request: HarnessChatKitMessageRequest,
      sink: HarnessChatKitEventSink
    ): Promise<void> {
      const thread = ensureThread(request.createThread ? undefined : request.threadId)
      thread.model = request.model || thread.model || DEFAULT_MODEL
      withUpdatedThreadTitle(thread, request.input)

      const userItem: JsonRecord = {
        id: randomId('msg'),
        type: 'user_message',
        thread_id: thread.id,
        created_at: new Date().toISOString(),
        content: [
          {
            type: 'input_text',
            text: request.input,
          },
        ],
        attachments: [],
        inference_options: {
          model: request.model || DEFAULT_MODEL,
        },
      }
      thread.items.push(userItem)
      thread.updatedAt = new Date().toISOString()

      const vectorStores =
        responsesDirectConfigManager.getSnapshot().vectorStores
      const requestPayload = buildOpenAIResponsesRequestForInput({
        text: request.input,
        model: request.model || thread.model || DEFAULT_MODEL,
        previousResponseId: thread.previousResponseId,
        vectorStores,
      })

      if (request.createThread) {
        sink.emit({
          type: 'thread.created',
          thread: {
            id: thread.id,
            title: thread.title,
            created_at: thread.createdAt,
          },
        } as never)
      }
      sink.emit({
        type: 'thread.item.added',
        item: userItem,
      } as never)
      sink.emit({
        type: 'thread.item.done',
        item: userItem,
      } as never)
      await streamOpenAI({
        thread,
        responsesApiUrl,
        requestPayload,
        emit: sink.emit,
        signal: request.signal ?? null,
      })
    },
    async submitToolResult(
      request: HarnessChatKitToolResultRequest,
      sink: HarnessChatKitEventSink
    ): Promise<void> {
      const thread = ensureThread(request.threadId)
      const vectorStores =
        responsesDirectConfigManager.getSnapshot().vectorStores
      const requestPayload = buildOpenAIResponsesRequestForToolOutput({
        callId: request.callId,
        output: toOutputString(request.output),
        model: thread.model || DEFAULT_MODEL,
        previousResponseId: thread.previousResponseId,
        vectorStores,
      })
      await streamOpenAI({
        thread,
        responsesApiUrl,
        requestPayload,
        emit: sink.emit,
        signal: request.signal ?? null,
      })
    },
  }
}

export function createResponsesDirectChatkitFetch(options?: {
  responsesApiBaseUrl?: string
}): typeof fetch {
  return createChatKitFetchFromAdapter(
    createResponsesDirectChatKitAdapter(options),
    {
      unsupportedRequestPrefix: 'unsupported_responses_direct_request',
    }
  )
}
