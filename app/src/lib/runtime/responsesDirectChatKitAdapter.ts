import { getAccessToken } from '../../token'
import { appLogger } from '../logging/runtime'
import type { CodeModeExecutor } from './codeModeExecutor'
import { getCodeModeErrorOutput } from './codeModeExecutor'
import type { ChatKitThreadDetail } from './chatkitProtocol'
import type {
  ConversationController,
  ConversationControllerSnapshot,
  ConversationStreamSink,
} from './conversationController'
import { createChatKitFetchFromAdapter } from './createChatKitFetchFromAdapter'
import type {
  HarnessChatKitAdapter,
  HarnessChatKitEventSink,
  HarnessChatKitMessageRequest,
} from './harnessChatKitAdapter'
import { parseExecuteCodePayload } from './notebookToolHandlers'
import { responsesDirectConfigManager } from './responsesDirectConfigManager'
import { RUNME_RESPONSES_DIRECT_INSTRUCTIONS } from './runmeChatkitPrompts'

type JsonRecord = Record<string, unknown>

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

type PendingToolContinuation = {
  callId: string
  output: string
}

async function executeResponsesToolCall(args: {
  codeModeExecutor?: CodeModeExecutor
  toolName: string
  callId: string
  previousResponseId?: string
  argumentsRaw: string
}): Promise<PendingToolContinuation> {
  let parsedArguments: JsonRecord = {}
  try {
    parsedArguments = asRecord(JSON.parse(args.argumentsRaw))
  } catch {
    parsedArguments = {}
  }
  const enrichedPayload = {
    ...parsedArguments,
    call_id: args.callId,
    previous_response_id: args.previousResponseId ?? '',
  }
  const executeCodePayload = parseExecuteCodePayload(enrichedPayload)
  if (!executeCodePayload) {
    return {
      callId: args.callId,
      output: 'Tool execution failed: ExecuteCode tool invoked without valid code payload',
    }
  }

  if (args.toolName !== EXECUTE_CODE_TOOL_NAME) {
    return {
      callId: args.callId,
      output: `Tool execution failed: Unsupported tool ${args.toolName}`,
    }
  }

  if (!args.codeModeExecutor) {
    return {
      callId: args.callId,
      output:
        'Tool execution failed: ExecuteCode is unavailable because no code mode executor is configured',
    }
  }

  try {
    const result = await args.codeModeExecutor.execute({
      code: executeCodePayload.code,
      source: 'chatkit',
    })
    return {
      callId: args.callId,
      output: result.output,
    }
  } catch (error) {
    const output = getCodeModeErrorOutput(error)
    const failureMessage = `Tool execution failed: ${String(error)}`
    return {
      callId: args.callId,
      output: output ? `${output}\n${failureMessage}` : failureMessage,
    }
  }
}

class ResponsesDirectConversationController implements ConversationController {
  private readonly responsesApiUrl: string
  private readonly codeModeExecutor?: CodeModeExecutor
  private readonly threads = new Map<string, StoredThread>()
  private readonly listeners = new Set<() => void>()
  private currentThreadId: string | null = null
  private selectedModel = DEFAULT_MODEL

  constructor(options?: {
    responsesApiBaseUrl?: string
    codeModeExecutor?: CodeModeExecutor
  }) {
    this.responsesApiUrl = resolveResponsesApiUrl(
      options?.responsesApiBaseUrl ?? ''
    )
    this.codeModeExecutor = options?.codeModeExecutor
  }

  getSnapshot(): ConversationControllerSnapshot {
    return {
      currentThreadId: this.currentThreadId,
      threads: [...this.threads.values()].map((thread) => ({
        id: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
      })),
      loadingHistory: false,
      historyError: null,
      selectedModel: this.selectedModel,
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async refreshHistory(): Promise<void> {}

  newChat(): void {
    this.currentThreadId = null
    this.notify()
  }

  async selectThread(threadId: string): Promise<StoredThread> {
    const thread = this.getExistingThread(threadId)
    this.currentThreadId = thread.id
    this.notify()
    return thread
  }

  async getThread(threadId: string): Promise<StoredThread> {
    return this.getExistingThread(threadId)
  }

  async listItems(threadId: string): Promise<JsonRecord[]> {
    return this.getExistingThread(threadId).items
  }

  setSelectedModel(model: string): void {
    const trimmed = model.trim()
    if (!trimmed || trimmed === this.selectedModel) {
      return
    }
    this.selectedModel = trimmed
    this.notify()
  }

  async streamUserMessage(
    input: string,
    sink: ConversationStreamSink,
    modelOverride?: string,
    signal?: AbortSignal | null
  ): Promise<void> {
    const hadActiveThread = Boolean(this.currentThreadId)
    const thread = this.ensureThread(this.currentThreadId ?? undefined)
    this.currentThreadId = thread.id
    thread.model = modelOverride || this.selectedModel || thread.model || DEFAULT_MODEL
    withUpdatedThreadTitle(thread, input)

    if (!hadActiveThread) {
      sink.emit({
        type: 'thread.created',
        thread: {
          id: thread.id,
          title: thread.title,
          created_at: thread.createdAt,
        },
      } as never)
    }

    const userItem: JsonRecord = {
      id: randomId('msg'),
      type: 'user_message',
      thread_id: thread.id,
      created_at: new Date().toISOString(),
      content: [
        {
          type: 'input_text',
          text: input,
        },
      ],
      attachments: [],
      inference_options: {
        model: thread.model || DEFAULT_MODEL,
      },
    }
    thread.items.push(userItem)
    thread.updatedAt = new Date().toISOString()
    this.notify()

    const vectorStores =
      responsesDirectConfigManager.getSnapshot().vectorStores
    const requestPayload = buildOpenAIResponsesRequestForInput({
      text: input,
      model: thread.model || DEFAULT_MODEL,
      previousResponseId: thread.previousResponseId,
      vectorStores,
    })

    sink.emit({
      type: 'thread.item.added',
      item: userItem,
    } as never)
    sink.emit({
      type: 'thread.item.done',
      item: userItem,
    } as never)
    await this.streamOpenAI({
      thread,
      requestPayload,
      emit: sink.emit,
      signal,
    })
    this.notify()
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      listener()
    })
  }

  private getExistingThread(threadId: string): StoredThread {
    const thread = threadId ? this.threads.get(threadId) : undefined
    if (!thread) {
      throw new Error('thread_not_found')
    }
    return thread
  }

  private ensureThread(threadId?: string): StoredThread {
    const normalized = threadId?.trim() ?? ''
    if (normalized && this.threads.has(normalized)) {
      return this.threads.get(normalized)!
    }
    const now = new Date().toISOString()
    const created: StoredThread = {
      id: normalized || randomId('thread'),
      title: 'New conversation',
      createdAt: now,
      updatedAt: now,
      model: this.selectedModel || DEFAULT_MODEL,
      items: [],
    }
    this.threads.set(created.id, created)
    return created
  }

  private async streamOpenAI(options: {
    thread: StoredThread
    requestPayload: JsonRecord
    emit: (payload: unknown) => void
    signal?: AbortSignal | null
  }): Promise<void> {
    let nextPayload: JsonRecord | null = options.requestPayload
    while (nextPayload) {
      const currentPayload = nextPayload
      nextPayload = null

      const headers = await resolveResponsesDirectHeaders()
      const response = await fetch(this.responsesApiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(currentPayload),
        signal: options.signal ?? undefined,
      })
      if (!response.ok) {
        throw new Error(await readErrorBody(response))
      }

      const assistantTextByItem = new Map<string, string>()
      const toolNameByItem = new Map<string, string>()
      const toolCallIdByItem = new Map<string, string>()
      let pendingToolContinuationPromise:
        | Promise<PendingToolContinuation>
        | null = null

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
              if (!callId) {
                throw new Error('Responses function call missing call_id')
              }
              const name =
                asString(event.name) ??
                toolNameByItem.get(itemId) ??
                asString(asRecord(event.item).name) ??
                EXECUTE_CODE_TOOL_NAME
              const argumentsRaw = asString(event.arguments) ?? '{}'
              pendingToolContinuationPromise = executeResponsesToolCall({
                codeModeExecutor: this.codeModeExecutor,
                toolName: name,
                callId,
                previousResponseId: options.thread.previousResponseId,
                argumentsRaw,
              })
              return
            }
            case 'response.completed':
            default:
              return
          }
        },
        options.signal
      )

      const pendingToolContinuation = pendingToolContinuationPromise
        ? await pendingToolContinuationPromise
        : null
      if (pendingToolContinuation) {
        nextPayload = buildOpenAIResponsesRequestForToolOutput({
          callId: pendingToolContinuation.callId,
          output: pendingToolContinuation.output,
          model: options.thread.model || DEFAULT_MODEL,
          previousResponseId: options.thread.previousResponseId,
          vectorStores: responsesDirectConfigManager.getSnapshot().vectorStores,
        })
        continue
      }

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
    }
  }
}

export function createResponsesDirectConversationController(options?: {
  responsesApiBaseUrl?: string
  codeModeExecutor?: CodeModeExecutor
}): ConversationController {
  return new ResponsesDirectConversationController(options)
}

export function createResponsesDirectChatKitAdapter(
  controller: ConversationController
): HarnessChatKitAdapter {
  return {
    async listThreads() {
      await controller.refreshHistory()
      return controller.getSnapshot().threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        updated_at: thread.updatedAt,
      }))
    },
    async getThread(threadId: string) {
      const thread = await controller.getThread(threadId)
      return buildThreadDetail(thread as StoredThread)
    },
    async listItems(threadId: string) {
      return controller.listItems(threadId)
    },
    async streamUserMessage(
      request: HarnessChatKitMessageRequest,
      sink: HarnessChatKitEventSink
    ): Promise<void> {
      if (request.createThread) {
        controller.newChat()
      }
      if (
        request.threadId &&
        controller.getSnapshot().currentThreadId !== request.threadId
      ) {
        await controller.selectThread(request.threadId)
      }
      await controller.streamUserMessage(
        request.input,
        sink,
        request.model,
        request.signal ?? null
      )
    },
  }
}

export function createResponsesDirectChatkitFetch(options?: {
  responsesApiBaseUrl?: string
  codeModeExecutor?: CodeModeExecutor
}): typeof fetch {
  const controller = createResponsesDirectConversationController(options)
  return createChatKitFetchFromAdapter(
    createResponsesDirectChatKitAdapter(controller),
    {
      unsupportedRequestPrefix: 'unsupported_responses_direct_request',
    }
  )
}
