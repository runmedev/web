import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { ChatKit, useChatKit } from '../../lib/runtime/chatkitReact'
import {
  parser_pb,
} from '../../contexts/CellContext'
import { useNotebookContext } from '../../contexts/NotebookContext'
import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import {
  useHarness,
  getHarnessManager,
  buildChatkitUrl,
  type HarnessProfile,
} from '../../lib/runtime/harnessManager'
import {
  buildCodexChatKitFetchOptions,
} from '../../lib/runtime/codexChatKitAdapter'
import { createCodeModeExecutor } from '../../lib/runtime/codeModeExecutor'
import { createChatKitFetchFromAdapter } from '../../lib/runtime/createChatKitFetchFromAdapter'
import {
  getCodexConversationController,
  useCodexConversationSnapshot,
} from '../../lib/runtime/codexConversationController'
import {
  useConversationControllerSnapshot,
  type ConversationController,
} from '../../lib/runtime/conversationController'
import type {
  HarnessChatKitAdapter,
  HarnessRuntime,
} from '../../lib/runtime/harnessChatKitAdapter'
import { getHarnessRuntimeManager } from '../../lib/runtime/harnessRuntimeManager'
import {
  createCodexBridgeToolHandler,
} from '../../lib/runtime/notebookToolHandlers'
import {
  getCodexProjectManager,
  useCodexProjects,
} from '../../lib/runtime/codexProjectManager'
import { appLogger } from '../../lib/logging/runtime'
import {
  responsesDirectConfigManager,
  useResponsesDirectConfigSnapshot,
} from '../../lib/runtime/responsesDirectConfigManager'

import { getAccessToken, getAuthData } from '../../token'
import { getBrowserAdapter } from '../../browserAdapter.client'
import { getConfiguredChatKitDomainKey } from '../../lib/appConfig'
class UserNotLoggedInError extends Error {
  constructor(message = 'You must log in to use runme chat.') {
    super(message)
    this.name = 'UserNotLoggedInError'
  }
}

const CHATKIT_GREETING = 'How can runme help you today?'

const CHATKIT_PLACEHOLDER =
  'Describe the production issue or question you are investigating'

const CHAT_MODEL_STORAGE_KEY = 'runme/chat-shell-model-selection'
const DEFAULT_CHAT_MODEL = 'gpt-5.4'
const CHAT_MODEL_OPTIONS = [
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o Mini',
  },
  {
    id: 'gpt-5',
    label: 'GPT-5',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
  },
  {
    id: 'gpt-5.2',
    label: 'GPT-5.2',
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 Mini',
  },
  {
    id: 'gpt-5-nano',
    label: 'GPT-5 Nano',
  },
] as const

const CHATKIT_STARTER_PROMPTS = [
  {
    label: 'Setup a local runner for runme to execute code',
    prompt: 'How do I setup a local runner to execute code with runme?',
    icon: 'circle-question',
  },
  {
    label: 'Plot metrics',
    prompt: 'Plot the requests for the o3 model.',
    icon: 'book-open',
  },
  {
    label: 'Handle an alert or incident',
    prompt:
      'I just got paged for TBT (time between tokens) being high. Search notion, the mono-repo, and slack for runbooks for dealing with this alert and give me instrunctions for dealing with it?',
    icon: 'search',
  },
] as const

// Transitional: NotebookService currently exposes multiple notebook-specific tools.
// Design direction is to simplify the agent-facing surface to a single
// "execute JavaScript" capability and route notebook mutations through the
// sandbox NotebooksApi.
type SSEInterceptor = (rawEvent: string) => void
type ChatKitTurnTiming = {
  submittedAtMs: number
  submittedAtIso: string
  prompt: string
  responseId: string | null
  firstVisibleMessageAtMs: number | null
}

function isCodexHarness(adapter: HarnessProfile['adapter']): boolean {
  return adapter === 'codex' || adapter === 'codex-wasm'
}

function readPersistedModelSelection(
  adapter: HarnessProfile['adapter']
): string | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  try {
    const raw = window.localStorage.getItem(CHAT_MODEL_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const value = parsed[adapter]
    return typeof value === 'string' && value.trim() ? value : null
  } catch {
    return null
  }
}

function persistModelSelection(
  adapter: HarnessProfile['adapter'],
  model: string
): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  try {
    const raw = window.localStorage.getItem(CHAT_MODEL_STORAGE_KEY)
    const parsed =
      raw && raw.trim()
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {}
    parsed[adapter] = model
    window.localStorage.setItem(
      CHAT_MODEL_STORAGE_KEY,
      JSON.stringify(parsed)
    )
  } catch {
    // Ignore persistence failures and continue with in-memory state.
  }
}

function extractResponseIdFromSSEEvent(
  payload: Record<string, unknown>
): string | null {
  const response = payload.response
  if (
    response &&
    typeof response === 'object' &&
    !Array.isArray(response) &&
    typeof (response as { id?: unknown }).id === 'string'
  ) {
    return (response as { id: string }).id
  }
  return typeof payload.response_id === 'string' ? payload.response_id : null
}

function extractVisibleTextFromSSEEvent(
  payload: Record<string, unknown>
): string {
  if (
    typeof payload.delta === 'string' &&
    payload.delta.trim().length > 0
  ) {
    return payload.delta
  }
  if (
    typeof payload.text === 'string' &&
    payload.text.trim().length > 0
  ) {
    return payload.text
  }
  const part = payload.part
  if (
    part &&
    typeof part === 'object' &&
    !Array.isArray(part) &&
    typeof (part as { text?: unknown }).text === 'string'
  ) {
    const text = (part as { text: string }).text
    if (text.trim().length > 0) {
      return text
    }
  }
  const item = payload.item
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const content = (item as { content?: unknown }).content
    if (Array.isArray(content)) {
      const text = content
        .map((part) =>
          part &&
          typeof part === 'object' &&
          !Array.isArray(part) &&
          typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : ''
        )
        .join('')
      if (text.trim().length > 0) {
        return text
      }
    }
  }
  return ''
}

function summarizePromptForTimingLog(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ''
  }
  const textItems = Array.isArray((data as { text?: unknown }).text)
    ? ((data as { text: Array<unknown> }).text ?? [])
    : []
  return textItems
    .map((item) =>
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      typeof (item as { text?: unknown }).text === 'string'
        ? (item as { text: string }).text
        : ''
    )
    .join('')
}

const useInterceptedFetch = (
  baseFetch?: typeof fetch,
  onSSEEvent?: SSEInterceptor
) => {
  return useMemo(() => {
    const fetchImpl = baseFetch ?? fetch
    const interceptedFetch: typeof fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      try {
        const response = await fetchImpl(input, init)
        //return response;
        const isSSE =
          onSSEEvent &&
          response.headers
            .get('content-type')
            ?.toLowerCase()
            .includes('text/event-stream') &&
          response.body

        if (!isSSE || !response.body) {
          return response
        }

        const decoder = new TextDecoder()
        const encoder = new TextEncoder()
        const reader = response.body.getReader()
        let buffer = ''

        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await reader.read()
            if (done) {
              const tail = decoder.decode()
              if (tail) {
                buffer += tail
              }
              if (buffer.length > 0) {
                try {
                  onSSEEvent?.(buffer)
                } catch (eventError) {
                  console.error('SSE interceptor error', eventError)
                }
                controller.enqueue(encoder.encode(buffer))
              }
              controller.close()
              return
            }

            if (value) {
              buffer += decoder.decode(value, { stream: true })
              let boundary
              while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                const rawEvent = buffer.slice(0, boundary + 2)
                buffer = buffer.slice(boundary + 2)
                try {
                  onSSEEvent?.(rawEvent)
                } catch (eventError) {
                  console.error('SSE interceptor error', eventError)
                }
                controller.enqueue(encoder.encode(rawEvent))
              }
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason)
            } catch (cancelError) {
              console.error('Failed to cancel SSE reader', cancelError)
            }
          },
        })

        const interceptedResponse = new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        })

        return interceptedResponse
      } catch (error) {
        console.error('ChatKit fetch failed', error)
        appLogger.error('ChatKit fetch failed', {
          attrs: {
            scope: 'chatkit.fetch',
            error: String(error),
          },
        })
        throw error
      }
    }

    return interceptedFetch
  }, [baseFetch, onSSEEvent])
}

type ChatKitPanelInnerProps = {
  defaultHarness: HarnessProfile
}

function ChatKitPanelInner({ defaultHarness }: ChatKitPanelInnerProps) {
  const [showLoginPrompt, setShowLoginPrompt] = useState(false)
  const [codexStreamError, setCodexStreamError] = useState<string | null>(null)
  const [codexThreadBootstrapComplete, setCodexThreadBootstrapComplete] =
    useState(
      defaultHarness.adapter !== 'codex' &&
        defaultHarness.adapter !== 'codex-wasm'
    )
  const [activeAdapter, setActiveAdapter] = useState<HarnessChatKitAdapter | null>(
    null
  )
  const [activeController, setActiveController] =
    useState<ConversationController | null>(null)
  const chatkitDomainKey = getConfiguredChatKitDomainKey()
  const [showConversationDrawer, setShowConversationDrawer] = useState(false)
  const [drawerThreadsLoading, setDrawerThreadsLoading] = useState(false)
  const [drawerThreadsError, setDrawerThreadsError] = useState<string | null>(null)
  const runtimeRef = useRef<HarnessRuntime | null>(null)
  const activeTurnTimingRef = useRef<ChatKitTurnTiming | null>(null)
  const chatkitActionsRef = useRef<{
    setThreadId: (threadId: string | null, source?: string) => Promise<void>
    fetchUpdates: (source?: string) => Promise<void>
  } | null>(null)
  const lastAppliedThreadRef = useRef<string | null>(null)
  const harnessRuntimeManager = useMemo(() => getHarnessRuntimeManager(), [])
  const { getNotebookData, useNotebookList } =
    useNotebookContext()
  const { getCurrentDoc } = useCurrentDoc()
  const responsesDirectConfig = useResponsesDirectConfigSnapshot()
  const codexProjects = useCodexProjects()
  const { defaultProject } = codexProjects
  const codexConversation = useCodexConversationSnapshot()
  const conversationSnapshot = useConversationControllerSnapshot(activeController)
  const currentDocUri = getCurrentDoc()
  const openNotebookList = useNotebookList()
  const getNotebookDataRef = useRef(getNotebookData)
  getNotebookDataRef.current = getNotebookData
  const openNotebookListRef = useRef(openNotebookList)
  openNotebookListRef.current = openNotebookList
  const currentDocUriRef = useRef(currentDocUri)
  currentDocUriRef.current = currentDocUri
  const currentThreadId = conversationSnapshot?.currentThreadId ?? null
  const selectedModel =
    conversationSnapshot?.selectedModel ??
    readPersistedModelSelection(defaultHarness.adapter) ??
    DEFAULT_CHAT_MODEL
  const drawerThreads = conversationSnapshot?.threads ?? []

  const resolveCodeModeNotebook = useCallback(
    (target?: unknown) => {
      const targetUri =
        typeof target === 'string'
          ? target
          : typeof target === 'object' && target && 'uri' in target
            ? (target as { uri?: string }).uri
            : typeof target === 'object' &&
                target &&
                'handle' in target &&
                (target as { handle?: { uri?: string } }).handle?.uri
              ? (target as { handle?: { uri?: string } }).handle?.uri
              : currentDocUriRef.current
      if (!targetUri) {
        return null
      }
      const data = getNotebookDataRef.current(targetUri)
      if (!data) {
        return null
      }

      return {
        getUri: () => data.getUri(),
        getName: () => data.getName(),
        getNotebook: () => data.getNotebook(),
        updateCell: (cell: parser_pb.Cell) => {
          for (const renderer of getAllRenderersRef.current().values()) {
            renderer.onCellUpdate(cell)
          }
          data.updateCell(cell)
        },
        getCell: (refId: string) => data.getCell(refId),
        appendCodeCell: data.appendCodeCell?.bind(data),
        addCodeCellAfter: data.addCodeCellAfter?.bind(data),
        addCodeCellBefore: data.addCodeCellBefore?.bind(data),
        removeCell: data.removeCell?.bind(data),
      }
    },
    []
  )

  const codeModeExecutor = useMemo(
    () =>
      createCodeModeExecutor({
        mode: 'sandbox',
        resolveNotebook: resolveCodeModeNotebook,
        listNotebooks: () => {
          const uris = new Set<string>()
          for (const notebook of openNotebookListRef.current) {
            if (typeof notebook?.uri === 'string' && notebook.uri.trim()) {
              uris.add(notebook.uri)
            }
          }
          if (currentDocUriRef.current) {
            uris.add(currentDocUriRef.current)
          }
          return Array.from(uris)
            .map((uri) => resolveCodeModeNotebook(uri))
            .filter(
              (
                notebook
              ): notebook is NonNullable<
                ReturnType<typeof resolveCodeModeNotebook>
              > => Boolean(notebook)
            )
        },
      }),
    [resolveCodeModeNotebook]
  )

  const handleCodexBridgeToolCall = useMemo(
    () =>
      createCodexBridgeToolHandler({
        codeModeExecutor,
      }),
    [codeModeExecutor]
  )
  const handleSseEvent = useCallback(
    (rawEvent: string) => {
      const logTiming = (
        phase: string,
        attrs: Record<string, unknown>
      ) => {
        appLogger.info('ChatKit timing', {
          attrs: {
            scope: 'chatkit.panel',
            adapter: defaultHarness.adapter,
            phase,
            ...attrs,
          },
        })
      }
      const lines = rawEvent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      for (const line of lines) {
        if (!line.startsWith('data:')) {
          continue
        }
        const payload = line.slice('data:'.length).trim()
        if (!payload) {
          continue
        }

        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>
          if (parsed?.type === 'response.failed') {
            const message =
              typeof parsed?.error?.message === 'string'
                ? parsed.error.message
                : 'Codex request failed.'
            const activeTurn = activeTurnTimingRef.current
            if (activeTurn) {
              logTiming('failed', {
                responseId:
                  extractResponseIdFromSSEEvent(parsed) ?? activeTurn.responseId,
                elapsedMs: Math.round(performance.now() - activeTurn.submittedAtMs),
                submittedAt: activeTurn.submittedAtIso,
                promptChars: activeTurn.prompt.length,
                error: message,
              })
              activeTurnTimingRef.current = null
            }
            appLogger.error('ChatKit response stream failed', {
              attrs: {
                scope: 'chatkit.panel',
                adapter: defaultHarness.adapter,
                error: message,
              },
            })
            setCodexStreamError(message)
            continue
          }
          if (
            parsed?.type === 'response.created' ||
            parsed?.type === 'response.output_text.delta' ||
            parsed?.type === 'response.completed'
          ) {
            setCodexStreamError(null)
          }
          if (parsed?.type === 'response.created') {
            const responseId = extractResponseIdFromSSEEvent(parsed)
            const activeTurn = activeTurnTimingRef.current
            if (activeTurn && responseId) {
              activeTurn.responseId = responseId
              logTiming('response_created', {
                responseId,
                elapsedMs: Math.round(
                  performance.now() - activeTurn.submittedAtMs
                ),
                submittedAt: activeTurn.submittedAtIso,
                promptChars: activeTurn.prompt.length,
              })
            }
          }
          if (
            parsed?.type === 'response.output_text.delta' ||
            parsed?.type === 'response.output_text.done' ||
            parsed?.type === 'response.content_part.done' ||
            parsed?.type === 'response.output_item.done'
          ) {
            const activeTurn = activeTurnTimingRef.current
            const visibleText = extractVisibleTextFromSSEEvent(parsed)
            if (visibleText) {
              appLogger.info('ChatKit visible stream event', {
                attrs: {
                  scope: 'chatkit.panel',
                  adapter: defaultHarness.adapter,
                  responseId:
                    extractResponseIdFromSSEEvent(parsed) ?? activeTurn?.responseId,
                  eventType: parsed.type,
                  textChars: visibleText.length,
                  preview: visibleText.slice(0, 160),
                },
              })
            }
            if (
              activeTurn &&
              activeTurn.firstVisibleMessageAtMs == null &&
              visibleText
            ) {
              activeTurn.firstVisibleMessageAtMs = performance.now()
              logTiming('first_visible_message', {
                responseId:
                  extractResponseIdFromSSEEvent(parsed) ?? activeTurn.responseId,
                eventType: parsed.type,
                ttfmMs: Math.round(
                  activeTurn.firstVisibleMessageAtMs - activeTurn.submittedAtMs
                ),
                submittedAt: activeTurn.submittedAtIso,
                promptChars: activeTurn.prompt.length,
                preview: visibleText.slice(0, 160),
              })
            }
          }
          if (parsed?.type === 'response.completed') {
            const activeTurn = activeTurnTimingRef.current
            if (activeTurn) {
              logTiming('completed', {
                responseId:
                  extractResponseIdFromSSEEvent(parsed) ?? activeTurn.responseId,
                totalTurnTimeMs: Math.round(
                  performance.now() - activeTurn.submittedAtMs
                ),
                submittedAt: activeTurn.submittedAtIso,
                promptChars: activeTurn.prompt.length,
                sawFirstVisibleMessage: activeTurn.firstVisibleMessageAtMs != null,
              })
              activeTurnTimingRef.current = null
            }
          }
        } catch (error) {
          appLogger.warn('Failed to parse SSE state event', {
            attrs: {
              scope: 'chatkit.panel',
              adapter: defaultHarness.adapter,
              error: String(error),
              payload,
            },
          })
        }
      }
    },
    [defaultHarness.adapter]
  )
  const baseFetch = useMemo(() => {
    if (!activeAdapter) {
      return undefined
    }
    if (isCodexHarness(defaultHarness.adapter)) {
      return createChatKitFetchFromAdapter(
        activeAdapter,
        {
          ...buildCodexChatKitFetchOptions(),
          resolveModel: () => selectedModel,
        }
      )
    }
    return createChatKitFetchFromAdapter(activeAdapter, {
      unsupportedRequestPrefix: 'unsupported_responses_direct_request',
      resolveModel: () => selectedModel,
    })
  }, [activeAdapter, defaultHarness.adapter, selectedModel])
  const interceptedFetch = useInterceptedFetch(baseFetch, handleSseEvent)

  const chatkitApiUrl = useMemo(() => {
    return buildChatkitUrl(defaultHarness.baseUrl, defaultHarness.adapter)
  }, [defaultHarness.adapter, defaultHarness.baseUrl])
  useEffect(() => {
    appLogger.info('ChatKit host configured', {
      attrs: {
        scope: 'chatkit.panel',
        adapter: defaultHarness.adapter,
        apiUrl: chatkitApiUrl,
        domainKeyConfigured: Boolean(chatkitDomainKey),
        selectedProjectId: isCodexHarness(defaultHarness.adapter)
          ? codexConversation.selectedProject.id
          : null,
      },
    })
  }, [
    chatkitApiUrl,
    chatkitDomainKey,
    codexConversation.selectedProject.id,
    defaultHarness.adapter,
  ])
  const resolveCodexAuthorization = useCallback(async (): Promise<string> => {
    const authData = await getAuthData()
    const idToken = authData?.idToken?.trim()
    if (!idToken) {
      const message = 'Codex websocket auth requires an OIDC id token'
      appLogger.error(message, {
        attrs: {
          scope: 'chatkit.codex_auth',
          adapter: defaultHarness.adapter,
          baseUrl: defaultHarness.baseUrl,
        },
      })
      setShowLoginPrompt(true)
      throw new UserNotLoggedInError(message)
    }
    return `Bearer ${idToken}`
  }, [defaultHarness.adapter, defaultHarness.baseUrl])

  const selectedProjectId =
    isCodexHarness(defaultHarness.adapter) ? defaultProject.id : undefined
  const codexBridgeHandler =
    defaultHarness.adapter === 'codex' ? handleCodexBridgeToolCall : undefined
  const wasmApiKey =
    defaultHarness.adapter === 'codex-wasm'
      ? responsesDirectConfig.apiKey
      : undefined
  const responsesApiBaseUrl =
    defaultHarness.adapter === 'responses-direct'
      ? defaultHarness.baseUrl
      : undefined

  useEffect(() => {
    setDrawerThreadsError(null)
    setDrawerThreadsLoading(false)
    setShowConversationDrawer(false)
  }, [defaultHarness.adapter])

  useEffect(() => {
    if (!activeController) {
      return
    }
    activeController.setSelectedModel(
      readPersistedModelSelection(defaultHarness.adapter) ?? DEFAULT_CHAT_MODEL
    )
  }, [activeController, defaultHarness.adapter])

  useEffect(() => {
    persistModelSelection(defaultHarness.adapter, selectedModel)
  }, [defaultHarness.adapter, selectedModel])

  const loadDrawerThreads = useCallback(async () => {
    if (!activeController) {
      return
    }
    setDrawerThreadsLoading(true)
    setDrawerThreadsError(null)
    try {
      await activeController.refreshHistory()
    } catch (error) {
      setDrawerThreadsError(String(error))
    } finally {
      setDrawerThreadsLoading(false)
    }
  }, [activeController])

  useEffect(() => {
    if (!showConversationDrawer) {
      return
    }
    void loadDrawerThreads()
  }, [loadDrawerThreads, showConversationDrawer, currentThreadId])

  useEffect(() => {
    const runtime = harnessRuntimeManager.getOrCreate({
      profile: defaultHarness,
      projectId: selectedProjectId,
      resolveAuthorization:
        defaultHarness.adapter === 'codex'
          ? resolveCodexAuthorization
          : undefined,
      codeModeExecutor,
      codexBridgeHandler,
      wasmApiKey,
      responsesApiBaseUrl,
    })
    runtimeRef.current = runtime
    lastAppliedThreadRef.current = null
    setActiveController(runtime.getConversationController())
    setActiveAdapter(runtime.createChatKitAdapter())
    setCodexThreadBootstrapComplete(
      defaultHarness.adapter !== 'codex' &&
        defaultHarness.adapter !== 'codex-wasm'
    )
    setCodexStreamError(null)

    let canceled = false
    void (async () => {
      try {
        await runtime.start()
        if (canceled) {
          return
        }
        setActiveController(runtime.getConversationController())
        setActiveAdapter(runtime.createChatKitAdapter())
        setCodexThreadBootstrapComplete(true)
      } catch (error) {
        if (canceled) {
          return
        }
        appLogger.error('Failed to initialize harness runtime', {
          attrs: {
            scope: 'chatkit.harness_runtime',
            adapter: defaultHarness.adapter,
            error: String(error),
            harness: defaultHarness.name,
          },
        })
        setCodexStreamError(`Failed to initialize harness: ${String(error)}`)
        setCodexThreadBootstrapComplete(true)
      }
    })()

    return () => {
      canceled = true
      runtime.stop()
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null
      }
      setActiveController(null)
      setActiveAdapter(null)
    }
  }, [
    codeModeExecutor,
    codexBridgeHandler,
    defaultHarness,
    harnessRuntimeManager,
    responsesApiBaseUrl,
    resolveCodexAuthorization,
    selectedProjectId,
    wasmApiKey,
  ])

  useEffect(() => {
    if (
      !isCodexHarness(defaultHarness.adapter) ||
      !codexThreadBootstrapComplete ||
      !conversationSnapshot
    ) {
      lastAppliedThreadRef.current = null
      return
    }
    const threadId = conversationSnapshot.currentThreadId ?? null
    if (!threadId || lastAppliedThreadRef.current === threadId) {
      return
    }
    lastAppliedThreadRef.current = threadId
    void chatkitActionsRef.current?.setThreadId(threadId, 'bootstrap_sync')
  }, [
    codexThreadBootstrapComplete,
    conversationSnapshot,
    defaultHarness.adapter,
  ])

  const chatkit = useChatKit({
    api: {
      url: chatkitApiUrl,
      domainKey: chatkitDomainKey,
      fetch: interceptedFetch,
    },
    initialThread: conversationSnapshot?.currentThreadId ?? undefined,
    theme: {
      colorScheme: 'light',
      radius: 'round',
    },
    startScreen: {
      greeting: CHATKIT_GREETING,
      prompts: CHATKIT_STARTER_PROMPTS,
    },
    // see: https://openai.github.io/chatkit-js/api/openai/chatkit/type-aliases/composeroption/#tools
    composer: {
      placeholder: CHATKIT_PLACEHOLDER,
      // TODO(jlewi): We want to make the company knowledge tool optional but on by default.
      // Unfortunately if we make it a tool it is not on by default and there doesn't seem to be a way to
      // select it programmatically.
      // tools: [
      //   {
      //     icon: "search" as ChatKitIcon,
      //     id: "company-knowledge",
      //     label: "Search Company Knowledge",
      //     persistent: true,
      //     pinned: true,
      //   },
      // ],
    },
    header: {
      enabled: false,
    },
    history: {
      enabled: false,
    },
    onError: ({ error }) => {
      const promptForLogin = () => setShowLoginPrompt(true)
      const errorText =
        typeof error === 'string'
          ? error
          : error && typeof error === 'object' && 'message' in error
            ? String((error as { message?: unknown }).message)
            : String(error)

      // This is a bit of a hacky way to check for authentication errors.
      // Chatkit throws a StreamError if the user isn't logged in.
      void (async () => {
        if (
          defaultHarness.adapter === 'responses-direct' &&
          responsesDirectConfigManager.getSnapshot().authMethod !== 'oauth'
        ) {
          return
        }
        const token = await getAccessToken()
        if (!token) {
          promptForLogin()
        }
      })()

      appLogger.error('ChatKit error', {
        attrs: {
          scope: 'chatkit.panel',
          adapter: defaultHarness.adapter,
          baseUrl: defaultHarness.baseUrl,
          error: errorText,
        },
      })
    },
    onThreadLoadStart: ({ threadId }) => {
      appLogger.info('ChatKit thread load start', {
        attrs: {
          scope: 'chatkit.panel',
          adapter: defaultHarness.adapter,
          threadId,
        },
      })
    },
    onThreadLoadEnd: ({ threadId }) => {
      appLogger.info('ChatKit thread load end', {
        attrs: {
          scope: 'chatkit.panel',
          adapter: defaultHarness.adapter,
          threadId,
        },
      })
    },
    onLog: ({ name, data }) => {
      if (
        name === 'composer.submit' &&
        isCodexHarness(defaultHarness.adapter)
      ) {
        const prompt = summarizePromptForTimingLog(data)
        const submittedAtIso = new Date().toISOString()
        activeTurnTimingRef.current = {
          submittedAtMs: performance.now(),
          submittedAtIso,
          prompt,
          responseId: null,
          firstVisibleMessageAtMs: null,
        }
        appLogger.info('ChatKit timing', {
          attrs: {
            scope: 'chatkit.panel',
            adapter: defaultHarness.adapter,
            phase: 'submit',
            submittedAt: submittedAtIso,
            promptChars: prompt.length,
            preview: prompt.slice(0, 160),
          },
        })
      }
      appLogger.info('ChatKit diagnostic log', {
        attrs: {
          scope: 'chatkit.panel',
          adapter: defaultHarness.adapter,
          name,
          data: data ?? null,
        },
      })
    },
    onThreadChange: ({ threadId }) => {
      const liveCodexSnapshot =
        isCodexHarness(defaultHarness.adapter)
          ? getCodexConversationController().getSnapshot()
          : null
      const liveCodexCurrentThreadId = liveCodexSnapshot?.currentThreadId ?? null
      const liveCodexCurrentTurnId = liveCodexSnapshot?.currentTurnId ?? null
      if (
        threadId == null &&
        isCodexHarness(defaultHarness.adapter) &&
        liveCodexCurrentThreadId
      ) {
        appLogger.info(
          'Ignoring null ChatKit thread change while Codex thread is active',
          {
            attrs: {
              scope: 'chatkit.panel',
              adapter: defaultHarness.adapter,
              threadId: null,
              codexCurrentThreadId: liveCodexCurrentThreadId,
              codexCurrentTurnId: liveCodexCurrentTurnId,
            },
          }
        )
        return
      }
      appLogger.info('ChatKit thread changed', {
        attrs: {
          scope: 'chatkit.panel',
          adapter: defaultHarness.adapter,
          threadId: threadId ?? null,
          codexCurrentThreadId: isCodexHarness(defaultHarness.adapter)
            ? liveCodexCurrentThreadId
            : null,
          codexCurrentTurnId: isCodexHarness(defaultHarness.adapter)
            ? liveCodexCurrentTurnId
            : null,
        },
      })
    },
  })
  const setChatkitThreadId = useCallback(
    async (threadId: string | null, source = 'panel_ref') => {
      appLogger.info('Calling ChatKit setThreadId', {
        attrs: {
          scope: 'chatkit.panel',
          adapter: defaultHarness.adapter,
          threadId,
          source,
        },
      })
      try {
        await chatkit.setThreadId(threadId)
        appLogger.info('ChatKit setThreadId completed', {
          attrs: {
            scope: 'chatkit.panel',
            adapter: defaultHarness.adapter,
            threadId,
            source,
          },
        })
      } catch (error) {
        appLogger.error('ChatKit setThreadId failed', {
          attrs: {
            scope: 'chatkit.panel',
            adapter: defaultHarness.adapter,
            threadId,
            source,
            error: String(error),
          },
        })
        throw error
      }
    },
    [chatkit, defaultHarness.adapter]
  )
  const fetchChatkitUpdates = useCallback(
    async (source = 'panel_ref') => {
      appLogger.info('Calling ChatKit fetchUpdates', {
        attrs: {
          scope: 'chatkit.panel',
          adapter: defaultHarness.adapter,
          source,
        },
      })
      try {
        await chatkit.fetchUpdates()
        appLogger.info('ChatKit fetchUpdates completed', {
          attrs: {
            scope: 'chatkit.panel',
            adapter: defaultHarness.adapter,
            source,
          },
        })
      } catch (error) {
        appLogger.error('ChatKit fetchUpdates failed', {
          attrs: {
            scope: 'chatkit.panel',
            adapter: defaultHarness.adapter,
            source,
            error: String(error),
          },
        })
        throw error
      }
    },
    [chatkit, defaultHarness.adapter]
  )
  chatkitActionsRef.current = {
    setThreadId: setChatkitThreadId,
    fetchUpdates: fetchChatkitUpdates,
  }

  const handleNewChat = useCallback(async () => {
    setCodexStreamError(null)
    await activeController?.newChat()
    await chatkitActionsRef.current?.setThreadId(null, 'new_chat')
    setShowConversationDrawer(false)
  }, [activeController])

  const handleSelectThread = useCallback(async (threadId: string) => {
    await activeController?.selectThread(threadId)
    await chatkitActionsRef.current?.setThreadId(threadId, 'select_thread')
    await chatkitActionsRef.current?.fetchUpdates('select_thread')
    setShowConversationDrawer(false)
  }, [activeController])

  const handleCodexProjectChange = useCallback(async (projectId: string) => {
    if (activeController?.setSelectedProject) {
      await activeController.setSelectedProject(projectId)
    } else {
      getCodexProjectManager().setDefault(projectId)
    }
    await chatkitActionsRef.current?.setThreadId(null, 'project_change')
    setCodexStreamError(null)
    setShowConversationDrawer(false)
  }, [activeController])

  const handleToggleConversationDrawer = useCallback(async () => {
    if (showConversationDrawer) {
      setShowConversationDrawer(false)
      return
    }
    setShowConversationDrawer(true)
    await loadDrawerThreads()
  }, [loadDrawerThreads, showConversationDrawer])

  const handleLogin = useCallback(() => {
    setShowLoginPrompt(false)
    getBrowserAdapter().loginWithRedirect()
  }, [])

  const handleDismissPrompt = useCallback(() => {
    setShowLoginPrompt(false)
  }, [])

  const headerTitle = isCodexHarness(defaultHarness.adapter)
    ? codexConversation.selectedProject.name
    : 'AI Chat'

  return (
    <div className="relative flex h-full w-full flex-col bg-white">
      <div
        data-testid="chat-shell-header"
        className="border-b border-nb-cell-border bg-white px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="chat-shell-history-button"
            className="shrink-0 rounded border border-nb-cell-border px-3 py-1 text-sm text-nb-text hover:bg-nb-surface-2"
            onClick={() => {
              void handleToggleConversationDrawer()
            }}
          >
            History
          </button>
          <div
            data-testid="chat-shell-title"
            className="min-w-0 flex-1 truncate text-sm font-medium text-nb-text"
          >
            {headerTitle}
          </div>
          <button
            type="button"
            data-testid="chat-shell-new-chat-button"
            className="shrink-0 rounded border border-nb-cell-border px-3 py-1 text-sm text-nb-text hover:bg-nb-surface-2"
            onClick={() => {
              void handleNewChat()
            }}
          >
            New chat
          </button>
        </div>
        <div className="mt-2 flex justify-end">
          <label className="flex items-center gap-2 text-sm text-nb-text">
            <span className="text-nb-text-muted">Model</span>
            <select
              data-testid="chat-shell-model-select"
              className="rounded border border-nb-cell-border bg-white px-2 py-1 text-sm text-nb-text"
              value={selectedModel}
              onChange={(event) => {
                activeController?.setSelectedModel(event.target.value)
              }}
            >
              {CHAT_MODEL_OPTIONS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {!isCodexHarness(defaultHarness.adapter) ||
        codexThreadBootstrapComplete ? (
          <ChatKit control={chatkit.control} className="block h-full w-full" />
        ) : (
          <div
            data-testid="codex-chatkit-bootstrap"
            className="flex h-full w-full items-center justify-center text-sm text-nb-text-muted"
          >
            Initializing Codex thread...
          </div>
        )}
      </div>
      {isCodexHarness(defaultHarness.adapter) && codexStreamError ? (
        <div
          data-testid="codex-stream-error"
          className="absolute left-3 right-3 top-3 z-30 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 shadow-sm"
        >
          {codexStreamError}
        </div>
      ) : null}
      {showConversationDrawer ? (
        <div
          data-testid="conversation-drawer"
          className="absolute inset-y-0 left-0 z-40 flex w-[280px] flex-col border-r border-nb-cell-border bg-white/95 shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-nb-cell-border px-3 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-nb-text-muted">
              {isCodexHarness(defaultHarness.adapter)
                ? 'Project and Conversations'
                : 'Conversations'}
            </div>
            <button
              type="button"
              data-testid="conversation-drawer-close"
              aria-label="Close conversation drawer"
              className="rounded border border-nb-cell-border px-2 py-1 text-xs font-medium text-nb-text hover:bg-nb-surface-2"
              onClick={() => {
                setShowConversationDrawer(false)
              }}
            >
              Close
            </button>
          </div>
          {isCodexHarness(defaultHarness.adapter) ? (
            <div className="border-b border-nb-cell-border px-3 py-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-nb-text-muted">
                Codex Project
              </div>
              <select
                data-testid="codex-project-select"
                className="w-full rounded border border-nb-cell-border bg-white px-2 py-1 text-sm text-nb-text"
                value={codexConversation.selectedProject.id}
                onChange={(event) => {
                  void handleCodexProjectChange(event.target.value)
                }}
              >
                {codexProjects.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {drawerThreadsLoading ? (
              <div className="text-sm text-nb-text-muted">Loading...</div>
            ) : drawerThreadsError ? (
              <div className="text-sm text-red-700">{drawerThreadsError}</div>
            ) : drawerThreads.length === 0 ? (
              <div className="text-sm text-nb-text-muted">
                No conversations yet.
              </div>
            ) : (
              <div className="space-y-2">
                {drawerThreads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    data-testid={`codex-thread-${thread.id}`}
                    className={`w-full rounded border px-2 py-2 text-left text-sm ${
                      currentThreadId === thread.id
                        ? 'border-nb-accent bg-nb-surface-2'
                        : 'border-nb-cell-border bg-white'
                    }`}
                    onClick={() => {
                      void handleSelectThread(thread.id)
                    }}
                  >
                    <div className="font-medium text-nb-text">
                      {thread.title}
                    </div>
                    {thread.updatedAt ? (
                      <div className="mt-1 text-xs text-nb-text-muted">
                        {thread.updatedAt}
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
      {showLoginPrompt ? (
        <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-white/90 p-4 text-sm">
          <div className="w-full max-w-sm rounded-nb-md border border-nb-cell-border bg-white p-4 shadow-nb-lg">
            <p className="mb-4 text-nb-text">
              Please log in to use runme chat features.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-nb-text px-3 py-1 text-nb-text hover:bg-nb-surface-2"
                onClick={handleLogin}
              >
                Log In
              </button>
              <button
                type="button"
                className="rounded border border-nb-cell-border px-3 py-1 text-nb-text-muted hover:bg-nb-surface-2"
                onClick={handleDismissPrompt}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ChatKitPanel() {
  const { harnesses, defaultHarness } = useHarness()
  const harnessManager = useMemo(() => getHarnessManager(), [])
  const harnessSessionKey = `${defaultHarness.name}:${defaultHarness.baseUrl}:${defaultHarness.adapter}`

  const handleHarnessChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextHarnessName = event.target.value
      if (!nextHarnessName || nextHarnessName === defaultHarness.name) {
        return
      }
      harnessManager.setDefault(nextHarnessName)
    },
    [defaultHarness.name, harnessManager]
  )

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="min-h-0 flex-1">
        <ChatKitPanelInner
          key={harnessSessionKey}
          defaultHarness={defaultHarness}
        />
      </div>
      <div className="border-t border-nb-cell-border bg-white px-3 py-2">
        <label
          htmlFor="chatkit-harness-select"
          className="mb-1 block text-xs font-medium text-nb-text-muted"
        >
          Harness
        </label>
        <select
          id="chatkit-harness-select"
          data-testid="chatkit-harness-select"
          className="w-full rounded border border-nb-cell-border bg-white px-2 py-1 text-sm text-nb-text"
          value={defaultHarness.name}
          onChange={handleHarnessChange}
        >
          {harnesses.map((harness) => (
            <option key={harness.name} value={harness.name}>
              {`${harness.name} (${harness.adapter})`}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

export default ChatKitPanel
