import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChatKit, useChatKit, ChatKitIcon } from '@openai/chatkit-react'
import {
  parser_pb,
  RunmeMetadataKey,
  useCell,
} from '../../contexts/CellContext'
import { useNotebookContext } from '../../contexts/NotebookContext'
import { useOutput } from '../../contexts/OutputContext'
import { useCurrentDoc } from '../../contexts/CurrentDocContext'
import { create, fromJsonString, toJson } from '@bufbuild/protobuf'
import {
  useHarness,
  buildChatkitUrl,
  buildCodexAppServerWsUrl,
  buildCodexBridgeWsUrl,
  type HarnessProfile,
} from '../../lib/runtime/harnessManager'
import { getCodexToolBridge } from '../../lib/runtime/codexToolBridge'
import { getCodexExecuteApprovalManager } from '../../lib/runtime/codexExecuteApprovalManager'
import { getCodexAppServerProxyClient } from '../../lib/runtime/codexAppServerProxyClient'
import { createCodexChatkitFetch } from '../../lib/runtime/codexChatkitFetch'
import { createResponsesDirectChatkitFetch } from '../../lib/runtime/responsesDirectChatkitFetch'
import {
  createCodeModeExecutor,
  getCodeModeErrorOutput,
} from '../../lib/runtime/codeModeExecutor'
import {
  getCodexConversationController,
  useCodexConversationSnapshot,
} from '../../lib/runtime/codexConversationController'
import { useCodexProjects } from '../../lib/runtime/codexProjectManager'
import { appLogger } from '../../lib/logging/runtime'
import { responsesDirectConfigManager } from '../../lib/runtime/responsesDirectConfigManager'

import { getAccessToken, getAuthData } from '../../token'
import { getBrowserAdapter } from '../../browserAdapter.client'
import { type Cell } from '../../protogen/runme/parser/v1/parser_pb.js'
import {
  ToolCallInputSchema,
  ToolCallOutputSchema,
  ToolCallOutput_Status,
  UpdateCellsResponseSchema,
  GetCellsResponseSchema,
  ListCellsResponseSchema,
  ChatkitStateSchema,
  NotebookServiceExecuteCellsResponseSchema,
} from '../../protogen/oaiproto/aisre/notebooks_pb.js'
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
const TOOL_PREFIX = 'agent_tools_v1_NotebookService_'

const UPDATE_CELLS_TOOL = TOOL_PREFIX + 'UpdateCells'
const LIST_CELLS_TOOL = TOOL_PREFIX + 'ListCells'
const GET_CELLS_TOOL = TOOL_PREFIX + 'GetCells'
const EXECUTE_CODE_TOOL = TOOL_PREFIX + 'ExecuteCode'
const EXECUTE_CODE_DIRECT_TOOL = 'ExecuteCode'

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseExecuteCodePayload(value: unknown): {
  callId: string
  previousResponseId: string
  code: string
} | null {
  if (typeof value === 'string') {
    try {
      return parseExecuteCodePayload(JSON.parse(value))
    } catch {
      return null
    }
  }
  const root = asRecord(value)
  const executeCodeCandidate = root.executeCode ?? root.execute_code ?? root
  const executeCode = asRecord(executeCodeCandidate)
  const code = asString(executeCode.code)
  if (!code) {
    return null
  }
  return {
    callId: asString(root.callId ?? root.call_id),
    previousResponseId: asString(
      root.previousResponseId ?? root.previous_response_id
    ),
    code,
  }
}

function buildExecuteCodeToolOutput(args: {
  callId: string
  previousResponseId: string
  output: string
  clientError?: string
}): Record<string, unknown> {
  const hasError = Boolean(
    args.clientError && args.clientError.trim().length > 0
  )
  return {
    callId: args.callId,
    previousResponseId: args.previousResponseId,
    status: hasError ? 'STATUS_FAILED' : 'STATUS_SUCCESS',
    clientError: args.clientError ?? '',
    executeCode: {
      output: args.output,
    },
  }
}

type SSEInterceptor = (rawEvent: string) => void

const useAuthorizedFetch = (
  getChatkitState: () => ReturnType<(typeof ChatkitStateSchema)['create']>,
  options?: {
    onSSEEvent?: SSEInterceptor
    baseFetch?: typeof fetch
    includeRunmeHeaders?: boolean
    includeChatkitState?: boolean
  }
) => {
  const {
    onSSEEvent,
    baseFetch,
    includeRunmeHeaders = true,
    includeChatkitState = true,
  } = options ?? {}
  return useMemo(() => {
    const fetchImpl = baseFetch ?? fetch
    const resolveRequestBody = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<BodyInit | null | undefined> => {
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
    const authorizedFetch: typeof fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      try {
        const headers = new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined)
        )

        if (includeRunmeHeaders) {
          const authData = await getAuthData()
          const idToken = authData?.idToken ?? undefined
          const oaiAccessToken = await getAccessToken()
          if (!oaiAccessToken) {
            throw new UserNotLoggedInError()
          }
          if (idToken) {
            headers.set('Authorization', `Bearer ${idToken}`)
          }
          headers.set('OpenAIAccessToken', oaiAccessToken)
        }

        let body = await resolveRequestBody(input, init)
        const method =
          init?.method ?? (input instanceof Request ? input.method : 'GET')
        if (includeChatkitState && method.toUpperCase() === 'POST') {
          const state = getChatkitState()
          const chatkitStateJson = toJson(ChatkitStateSchema, state)
          if (body == null) {
            body = JSON.stringify({ chatkit_state: chatkitStateJson })
            headers.set('Content-Type', 'application/json')
          } else {
            if (typeof body === 'string') {
              try {
                const parsed = JSON.parse(body)
                parsed.chatkit_state = chatkitStateJson
                body = JSON.stringify(parsed)
              } catch {
                const payload = new FormData()
                payload.append('payload', body)
                payload.append(
                  'chatkit_state',
                  JSON.stringify(chatkitStateJson)
                )
                body = payload
              }
            } else if (body instanceof FormData) {
              body.set('chatkit_state', JSON.stringify(chatkitStateJson))
            } else if (body instanceof URLSearchParams) {
              body.set('chatkit_state', JSON.stringify(chatkitStateJson))
            } else if (body instanceof Blob || body instanceof ArrayBuffer) {
              const payload = new FormData()
              payload.append('payload', new Blob([body]))
              payload.append('chatkit_state', JSON.stringify(chatkitStateJson))
              body = payload
            }
          }
        }

        const nextInit: RequestInit = {
          ...init,
          headers,
          body,
        }

        const response = await fetchImpl(input, nextInit)
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
        console.error('ChatKit authorized fetch failed', error)
        appLogger.error('ChatKit authorized fetch failed', {
          attrs: {
            scope: 'chatkit.fetch',
            error: String(error),
          },
        })
        throw error
      }
    }

    return authorizedFetch
  }, [
    baseFetch,
    onSSEEvent,
    getChatkitState,
    includeRunmeHeaders,
    includeChatkitState,
  ])
}

type ChatKitPanelInnerProps = {
  defaultHarness: HarnessProfile
}

function ChatKitPanelInner({ defaultHarness }: ChatKitPanelInnerProps) {
  const [showLoginPrompt, setShowLoginPrompt] = useState(false)
  const [codexStreamError, setCodexStreamError] = useState<string | null>(null)
  const [codexThreadBootstrapComplete, setCodexThreadBootstrapComplete] =
    useState(defaultHarness.adapter !== 'codex')
  const chatkitDomainKey = getConfiguredChatKitDomainKey()
  const [showCodexDrawer, setShowCodexDrawer] = useState(false)
  const syncedCodexStateRef = useRef<{
    threadId: string | null
    previousResponseId: string | null
  }>({
    threadId: null,
    previousResponseId: null,
  })
  const chatkitActionsRef = useRef<{
    setThreadId: (threadId: string | null, source?: string) => Promise<void>
    fetchUpdates: (source?: string) => Promise<void>
  } | null>(null)
  const lastAppliedCodexThreadRef = useRef<string | null>(null)
  const { getChatkitState } = useCell()
  const { getNotebookData, useNotebookSnapshot, useNotebookList } =
    useNotebookContext()
  const { getCurrentDoc } = useCurrentDoc()
  const { getAllRenderers } = useOutput()
  const codexProjects = useCodexProjects()
  const { defaultProject } = codexProjects
  const codexConversation = useCodexConversationSnapshot()
  const currentDocUri = getCurrentDoc()
  const openNotebookList = useNotebookList()
  const notebookSnapshot = useNotebookSnapshot(currentDocUri ?? '')
  const orderedCells = useMemo(
    () => notebookSnapshot?.notebook.cells ?? [],
    [notebookSnapshot]
  )
  const updateCell = useCallback(
    (cell: Cell) => {
      if (!cell?.refId || !currentDocUri) {
        return
      }
      const data = getNotebookData(currentDocUri)
      if (!data) {
        return
      }
      for (const renderer of getAllRenderers().values()) {
        renderer.onCellUpdate(cell as unknown as parser_pb.Cell)
      }
      data.updateCell(cell as unknown as parser_pb.Cell)
    },
    [currentDocUri, getAllRenderers, getNotebookData]
  )

  const getLatestCells = useCallback((): Cell[] => {
    if (!currentDocUri) {
      return orderedCells
    }
    const data = getNotebookData(currentDocUri)
    return (data?.getNotebook().cells ?? orderedCells) as unknown as Cell[]
  }, [currentDocUri, getNotebookData, orderedCells])

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
              : currentDocUri
      if (!targetUri) {
        return null
      }
      const data = getNotebookData(targetUri)
      if (!data) {
        return null
      }

      return {
        getUri: () => data.getUri(),
        getName: () => data.getName(),
        getNotebook: () => data.getNotebook(),
        updateCell: (cell: parser_pb.Cell) => {
          for (const renderer of getAllRenderers().values()) {
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
    [currentDocUri, getAllRenderers, getNotebookData]
  )

  const codeModeExecutor = useMemo(
    () =>
      createCodeModeExecutor({
        mode: 'sandbox',
        resolveNotebook: resolveCodeModeNotebook,
        listNotebooks: () => {
          const uris = new Set<string>()
          for (const notebook of openNotebookList) {
            if (typeof notebook?.uri === 'string' && notebook.uri.trim()) {
              uris.add(notebook.uri)
            }
          }
          if (currentDocUri) {
            uris.add(currentDocUri)
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
    [currentDocUri, openNotebookList, resolveCodeModeNotebook]
  )

  const waitForCellExecutionToComplete = useCallback(
    async (refId: string, timeoutMs = 60_000): Promise<void> => {
      if (!currentDocUri) {
        throw new Error('No active notebook for ExecuteCells')
      }
      const startedAt = Date.now()
      while (Date.now() - startedAt < timeoutMs) {
        const data = getNotebookData(currentDocUri)
        const updatedCell = data
          ?.getNotebook()
          .cells.find((cell) => cell.refId === refId)
        const exitCode = updatedCell?.metadata?.[RunmeMetadataKey.ExitCode]
        if (typeof exitCode === 'string') {
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(
        `Timed out waiting for cell execution to finish: ${refId}`
      )
    },
    [currentDocUri, getNotebookData]
  )

  const executeCellsWithApproval = useCallback(
    async (bridgeCallId: string, refIds: string[]): Promise<Cell[]> => {
      if (!currentDocUri) {
        throw new Error('No active notebook for ExecuteCells')
      }
      const notebookData = getNotebookData(currentDocUri)
      if (!notebookData) {
        throw new Error('No active notebook data for ExecuteCells')
      }
      const normalizedRefIds = refIds.filter(
        (id) => typeof id === 'string' && id.trim() !== ''
      )
      if (normalizedRefIds.length === 0) {
        throw new Error('ExecuteCells request missing refIds')
      }

      await getCodexExecuteApprovalManager().requestApproval(
        bridgeCallId,
        normalizedRefIds
      )

      for (const refId of normalizedRefIds) {
        const cellData = notebookData.getCell(refId)
        if (!cellData) {
          throw new Error(`Cell not found for ExecuteCells: ${refId}`)
        }
        cellData.run()
      }

      for (const refId of normalizedRefIds) {
        await waitForCellExecutionToComplete(refId)
      }

      const latestCells = notebookData.getNotebook().cells as unknown as Cell[]
      return normalizedRefIds
        .map((refId) => latestCells.find((cell) => cell.refId === refId))
        .filter((cell): cell is Cell => Boolean(cell))
    },
    [currentDocUri, getNotebookData, waitForCellExecutionToComplete]
  )

  const handleCodexBridgeToolCall = useCallback(
    async ({
      bridgeCallId,
      toolCallInput,
    }: {
      bridgeCallId: string
      toolCallInput: unknown
    }): Promise<unknown> => {
      const rawExecuteCodePayload = parseExecuteCodePayload(toolCallInput)
      if (rawExecuteCodePayload) {
        const callId = rawExecuteCodePayload.callId || bridgeCallId
        try {
          const result = await codeModeExecutor.execute({
            code: rawExecuteCodePayload.code,
            source: 'codex',
          })
          return buildExecuteCodeToolOutput({
            callId,
            previousResponseId: rawExecuteCodePayload.previousResponseId,
            output: result.output,
          })
        } catch (error) {
          return buildExecuteCodeToolOutput({
            callId,
            previousResponseId: rawExecuteCodePayload.previousResponseId,
            output: getCodeModeErrorOutput(error),
            clientError: String(error),
          })
        }
      }

      let decodedInput
      try {
        const payload =
          typeof toolCallInput === 'string'
            ? toolCallInput
            : JSON.stringify(toolCallInput ?? {})
        decodedInput = fromJsonString(ToolCallInputSchema, payload)
      } catch (error) {
        const failedOutput = create(ToolCallOutputSchema, {
          status: ToolCallOutput_Status.FAILED,
          clientError: `Failed to decode tool params: ${error}`,
        })
        return toJson(ToolCallOutputSchema, failedOutput)
      }

      const toolOutput = create(ToolCallOutputSchema, {
        callId: decodedInput.callId,
        previousResponseId: decodedInput.previousResponseId,
        status: ToolCallOutput_Status.SUCCESS,
        clientError: '',
      })
      const latestCells = getLatestCells()
      const cellMap = new Map<string, Cell>()
      latestCells.forEach((cell) => {
        cellMap.set(cell.refId, cell)
      })

      const inputCase = String(decodedInput.input?.case ?? '')
      switch (inputCase) {
        case 'updateCells': {
          const cells = decodedInput.input.value?.cells ?? []
          if (cells.length === 0) {
            toolOutput.status = ToolCallOutput_Status.FAILED
            toolOutput.clientError = 'UpdateCells invoked without cells payload'
            break
          }
          cells.forEach((updatedCell: Cell) => updateCell(updatedCell))
          toolOutput.output = {
            case: 'updateCells',
            value: create(UpdateCellsResponseSchema, { cells }),
          }
          break
        }
        case 'listCells': {
          toolOutput.output = {
            case: 'listCells',
            value: create(ListCellsResponseSchema, { cells: getLatestCells() }),
          }
          break
        }
        case 'getCells': {
          const requestedRefs = decodedInput.input.value?.refIds ?? []
          const foundCells = requestedRefs
            .map((id: string) => cellMap.get(id))
            .filter((cell): cell is Cell => Boolean(cell))
          toolOutput.output = {
            case: 'getCells',
            value: create(GetCellsResponseSchema, { cells: foundCells }),
          }
          break
        }
        case 'executeCells': {
          try {
            const executedCells = await executeCellsWithApproval(
              bridgeCallId,
              decodedInput.input.value?.refIds ?? []
            )
            toolOutput.output = {
              case: 'executeCells',
              value: create(NotebookServiceExecuteCellsResponseSchema, {
                cells: executedCells,
              }),
            }
          } catch (error) {
            toolOutput.status = ToolCallOutput_Status.FAILED
            toolOutput.clientError = String(error)
          }
          break
        }
        case 'executeCode': {
          const code = decodedInput.input.value?.code ?? ''
          try {
            const result = await codeModeExecutor.execute({
              code,
              source: 'codex',
            })
            return buildExecuteCodeToolOutput({
              callId: decodedInput.callId || bridgeCallId,
              previousResponseId: decodedInput.previousResponseId ?? '',
              output: result.output,
            })
          } catch (error) {
            return buildExecuteCodeToolOutput({
              callId: decodedInput.callId || bridgeCallId,
              previousResponseId: decodedInput.previousResponseId ?? '',
              output: getCodeModeErrorOutput(error),
              clientError: String(error),
            })
          }
        }
        default: {
          toolOutput.status = ToolCallOutput_Status.FAILED
          toolOutput.clientError = `Unsupported codex notebook tool input: ${String(inputCase)}`
          break
        }
      }
      return toJson(ToolCallOutputSchema, toolOutput) as Record<string, unknown>
    },
    [codeModeExecutor, executeCellsWithApproval, getLatestCells, updateCell]
  )
  const handleSseEvent = useCallback(
    (rawEvent: string) => {
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
          const parsed = JSON.parse(payload)
          if (parsed?.type === 'response.failed') {
            const message =
              typeof parsed?.error?.message === 'string'
                ? parsed.error.message
                : 'Codex request failed.'
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
          if (parsed?.type !== 'aisre.chatkit.state') {
            continue
          }

          const item = parsed?.item ?? parsed?.Item
          if (!item) {
            continue
          }

          const stateData = item.state ?? item.State ?? item
          if (!stateData) {
            continue
          }

          const state = fromJsonString(
            ChatkitStateSchema,
            JSON.stringify(stateData)
          )
          if (defaultHarness.adapter === 'codex') {
            appLogger.info('Ignoring Codex ChatKit state event', {
              attrs: {
                scope: 'chatkit.panel',
                adapter: defaultHarness.adapter,
                threadId: state.threadId ?? null,
                previousResponseId: state.previousResponseId ?? null,
              },
            })
            continue
          }
          appLogger.info('Received ChatKit state event', {
            attrs: {
              scope: 'chatkit.panel',
              adapter: defaultHarness.adapter,
              threadId: state.threadId ?? null,
              previousResponseId: state.previousResponseId ?? null,
            },
          })
          // setChatkitState(state);
          if (state.previousResponseId || state.threadId) {
            console.log(
              'ChatKit state update',
              JSON.stringify(
                {
                  previous_response_id: state.previousResponseId,
                  thread_id: state.threadId,
                },
                null,
                2
              )
            )
          }
        } catch (error) {
          console.error('Failed to parse SSE state event', error, payload)
        }
      }
    },
    [defaultHarness.adapter]
  )
  const codexFetch = useMemo(() => createCodexChatkitFetch(), [])
  const responsesDirectFetch = useMemo(
    () =>
      createResponsesDirectChatkitFetch({
        responsesApiBaseUrl:
          defaultHarness.adapter === 'responses-direct'
            ? defaultHarness.baseUrl
            : '',
      }),
    [defaultHarness.adapter, defaultHarness.baseUrl]
  )
  const getAuthorizedChatkitState = useCallback(() => {
    if (defaultHarness.adapter !== 'codex') {
      return getChatkitState()
    }
    const controllerSnapshot = getCodexConversationController().getSnapshot()
    return create(ChatkitStateSchema, {
      threadId:
        syncedCodexStateRef.current.threadId ??
        controllerSnapshot.currentThreadId ??
        '',
      previousResponseId: syncedCodexStateRef.current.previousResponseId ?? '',
    })
  }, [defaultHarness.adapter, getChatkitState])
  const authorizedFetch = useAuthorizedFetch(getAuthorizedChatkitState, {
    onSSEEvent: handleSseEvent,
    baseFetch:
      defaultHarness.adapter === 'codex' ? codexFetch : responsesDirectFetch,
    includeRunmeHeaders: defaultHarness.adapter === 'codex',
    includeChatkitState: defaultHarness.adapter === 'codex',
  })

  const chatkitApiUrl = useMemo(() => {
    return buildChatkitUrl(defaultHarness.baseUrl, defaultHarness.adapter)
  }, [defaultHarness.adapter, defaultHarness.baseUrl])
  const codexProxyWsUrl = useMemo(() => {
    return buildCodexAppServerWsUrl(defaultHarness.baseUrl)
  }, [defaultHarness.baseUrl])
  const codexBridgeUrl = useMemo(() => {
    return buildCodexBridgeWsUrl(defaultHarness.baseUrl)
  }, [defaultHarness.baseUrl])
  useEffect(() => {
    appLogger.info('ChatKit host configured', {
      attrs: {
        scope: 'chatkit.panel',
        adapter: defaultHarness.adapter,
        apiUrl: chatkitApiUrl,
        domainKeyConfigured: Boolean(chatkitDomainKey),
        selectedProjectId:
          defaultHarness.adapter === 'codex'
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

  useEffect(() => {
    if (defaultHarness.adapter !== 'codex') {
      return
    }
    const controller = getCodexConversationController()
    controller.setSelectedProject(defaultProject.id)
  }, [defaultHarness.adapter, defaultProject.id])

  useEffect(() => {
    const proxy = getCodexAppServerProxyClient()
    if (defaultHarness.adapter !== 'codex') {
      setCodexThreadBootstrapComplete(true)
      proxy.setAuthorizationResolver(null)
      proxy.disconnect()
      return
    }
    setCodexThreadBootstrapComplete(false)
    setCodexStreamError(null)
    proxy.setAuthorizationResolver(resolveCodexAuthorization)
    let canceled = false
    void (async () => {
      try {
        const authorization = await resolveCodexAuthorization()
        if (canceled) {
          return
        }
        await proxy.connect(codexProxyWsUrl, authorization)
        if (!canceled) {
          const controller = getCodexConversationController()
          await controller.refreshHistory()
          const thread = await controller.ensureActiveThread()
          // setChatkitState(
          //   create(ChatkitStateSchema, {
          //     threadId: thread.id,
          //     previousResponseId: thread.previousResponseId ?? "",
          //   }),
          // );
          syncedCodexStateRef.current = {
            threadId: thread.id,
            previousResponseId: thread.previousResponseId ?? null,
          }
          setCodexStreamError(null)
          setCodexThreadBootstrapComplete(true)
        }
      } catch (error) {
        if (canceled) {
          return
        }
        appLogger.error('Failed to connect codex app-server websocket', {
          attrs: {
            scope: 'chatkit.codex_proxy',
            error: String(error),
            url: codexProxyWsUrl,
          },
        })
        setCodexStreamError(
          `Failed to initialize Codex thread: ${String(error)}`
        )
        setCodexThreadBootstrapComplete(true)
      }
    })()
    return () => {
      canceled = true
      proxy.setAuthorizationResolver(null)
      proxy.disconnect()
    }
  }, [codexProxyWsUrl, defaultHarness.adapter, resolveCodexAuthorization])

  useEffect(() => {
    if (defaultHarness.adapter !== 'codex' || !codexThreadBootstrapComplete) {
      lastAppliedCodexThreadRef.current = null
      return
    }
    const threadId = syncedCodexStateRef.current.threadId
    if (!threadId || lastAppliedCodexThreadRef.current === threadId) {
      return
    }
    lastAppliedCodexThreadRef.current = threadId
    void chatkitActionsRef.current?.setThreadId(threadId, 'bootstrap_sync')
  }, [codexThreadBootstrapComplete, defaultHarness.adapter])

  useEffect(() => {
    const bridge = getCodexToolBridge()
    return bridge.subscribe(() => {
      const snapshot = bridge.getSnapshot()
      if (
        defaultHarness.adapter === 'codex' &&
        (snapshot.state === 'closed' || snapshot.state === 'error')
      ) {
        getCodexExecuteApprovalManager().failAll('Codex bridge disconnected')
      }
    })
  }, [defaultHarness.adapter])

  useEffect(() => {
    const bridge = getCodexToolBridge()
    if (defaultHarness.adapter !== 'codex') {
      bridge.setHandler(null)
      return
    }
    bridge.setHandler(handleCodexBridgeToolCall)
    return () => {
      bridge.setHandler(null)
    }
  }, [defaultHarness.adapter, handleCodexBridgeToolCall])

  useEffect(() => {
    const bridge = getCodexToolBridge()
    if (defaultHarness.adapter !== 'codex') {
      bridge.disconnect()
      getCodexExecuteApprovalManager().failAll('Codex bridge disabled')
      return
    }
    let canceled = false
    void (async () => {
      try {
        const authorization = await resolveCodexAuthorization()
        if (canceled) {
          return
        }
        await bridge.connect(codexBridgeUrl, authorization)
      } catch (error) {
        if (canceled) {
          return
        }
        appLogger.error('Failed to connect codex bridge websocket', {
          attrs: {
            scope: 'chatkit.codex_bridge',
            error: String(error),
            url: codexBridgeUrl,
          },
        })
      }
    })()
    return () => {
      canceled = true
      bridge.disconnect()
      getCodexExecuteApprovalManager().failAll('Codex bridge disconnected')
    }
  }, [codexBridgeUrl, defaultHarness.adapter, resolveCodexAuthorization])

  const chatkit = useChatKit({
    api: {
      url: chatkitApiUrl,
      domainKey: chatkitDomainKey,
      fetch: authorizedFetch,
    },
    initialThread:
      defaultHarness.adapter === 'codex'
        ? codexConversation.currentThreadId
        : undefined,
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
      models: [
        {
          id: 'gpt-4o-mini',
          label: 'GPT-4o Mini',
        },
        {
          id: 'gpt-5',
          label: 'GPT-5',
        },
        // gpt-5.2 appears to be about 2x as slow as gpt-4.1-mini-2025-04-14
        // but for a simple query that's 2s vs 1s so not a huge difference
        // This is still 10x faster than gpt 5 which took about 10x and felt like
        // molasses.
        {
          id: 'gpt-5.2',
          label: 'GPT-5.2',
          default: true,
        },
        {
          id: 'gpt-5-mini',
          label: 'GPT-5 Mini',
        },
        {
          id: 'gpt-5-nano',
          label: 'GPT-5 Nano',
        },
      ],
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
      enabled: true,
      title:
        defaultHarness.adapter === 'codex'
          ? {
              enabled: true,
              text: codexConversation.selectedProject.name,
            }
          : undefined,
      leftAction:
        defaultHarness.adapter === 'codex'
          ? {
              icon: showCodexDrawer ? 'close' : 'menu',
              onClick: () => setShowCodexDrawer((previous) => !previous),
            }
          : undefined,
      rightAction:
        defaultHarness.adapter === 'codex'
          ? {
              icon: 'compose',
              onClick: () => {
                void (async () => {
                  const controller = getCodexConversationController()
                  controller.startNewChat()
                  setCodexStreamError(null)
                  syncedCodexStateRef.current = {
                    threadId: null,
                    previousResponseId: null,
                  }
                  const thread = await controller.ensureActiveThread()
                  // setChatkitState(
                  //   create(ChatkitStateSchema, {
                  //     threadId: thread.id,
                  //     previousResponseId: thread.previousResponseId ?? "",
                  //   }),
                  // );
                  syncedCodexStateRef.current = {
                    threadId: thread.id,
                    previousResponseId: thread.previousResponseId ?? null,
                  }
                  await chatkitActionsRef.current?.setThreadId(
                    thread.id,
                    'header_new_chat'
                  )
                })()
              },
            }
          : undefined,
    },
    history: {
      enabled: defaultHarness.adapter !== 'codex',
    },
    onClientTool: async (invocation) => {
      const toolOutput = create(ToolCallOutputSchema, {
        callId: '',
        previousResponseId: '',
        status: ToolCallOutput_Status.SUCCESS,
        clientError: '',
      })

      switch (invocation.name) {
        case EXECUTE_CODE_DIRECT_TOOL:
        case EXECUTE_CODE_TOOL: {
          const executeCodePayload = parseExecuteCodePayload(invocation.params)
          if (!executeCodePayload) {
            toolOutput.status = ToolCallOutput_Status.FAILED
            toolOutput.clientError =
              'ExecuteCode tool invoked without valid code payload'
            return toJson(ToolCallOutputSchema, toolOutput) as Record<
              string,
              unknown
            >
          }
          if (!executeCodePayload.callId) {
            toolOutput.status = ToolCallOutput_Status.FAILED
            toolOutput.clientError =
              'ExecuteCode is missing call_id in tool params'
            return toJson(ToolCallOutputSchema, toolOutput) as Record<
              string,
              unknown
            >
          }

          const callId = executeCodePayload.callId
          const previousResponseId = executeCodePayload.previousResponseId
          try {
            const result = await codeModeExecutor.execute({
              code: executeCodePayload.code,
              source: 'chatkit',
            })
            if (invocation.name === EXECUTE_CODE_DIRECT_TOOL) {
              return {
                callId,
                previousResponseId,
                output: result.output,
              }
            }
            return buildExecuteCodeToolOutput({
              callId,
              previousResponseId,
              output: result.output,
            })
          } catch (error) {
            if (invocation.name === EXECUTE_CODE_DIRECT_TOOL) {
              return {
                callId,
                previousResponseId,
                output: getCodeModeErrorOutput(error),
                clientError: String(error),
              }
            }
            return buildExecuteCodeToolOutput({
              callId,
              previousResponseId,
              output: getCodeModeErrorOutput(error),
              clientError: String(error),
            })
          }
        }
        case UPDATE_CELLS_TOOL:
        case GET_CELLS_TOOL:
        case LIST_CELLS_TOOL:
          break
        default: {
          toolOutput.status = ToolCallOutput_Status.FAILED
          toolOutput.clientError = `Unknown tool ${invocation.name}`
          return toJson(ToolCallOutputSchema, toolOutput) as Record<
            string,
            unknown
          >
        }
      }

      let decodedInput
      try {
        const payload =
          typeof invocation.params === 'string'
            ? invocation.params
            : JSON.stringify(invocation.params ?? {})
        decodedInput = fromJsonString(ToolCallInputSchema, payload)
      } catch (error) {
        console.error('Failed to decode tool params', error, invocation.params)
        toolOutput.status = ToolCallOutput_Status.FAILED
        toolOutput.clientError = `Failed to decode tool params: ${error}`
        return {
          success: false,
          result: toJson(ToolCallOutputSchema, toolOutput),
        }
      }

      toolOutput.callId = decodedInput.callId
      toolOutput.previousResponseId = decodedInput.previousResponseId

      const inputCase = String(decodedInput.input?.case ?? '')
      const cellMap = new Map<string, Cell>()
      orderedCells.forEach((cell) => {
        cellMap.set(cell.refId, cell)
      })

      switch (invocation.name) {
        case UPDATE_CELLS_TOOL: {
          console.log(`[ChatKit tool] ${invocation.name}`, decodedInput)
          if (inputCase !== 'updateCells') {
            toolOutput.status = ToolCallOutput_Status.FAILED
            toolOutput.clientError =
              'UpdateCells tool invoked without updateCells payload'
            break
          }

          const updateCellsRequest = decodedInput.input.value
          if (!updateCellsRequest) {
            toolOutput.status = ToolCallOutput_Status.FAILED
            toolOutput.clientError = 'UpdateCells request missing payload'
            break
          }

          const cells: Cell[] = updateCellsRequest.cells ?? []
          if (cells.length === 0) {
            toolOutput.status = ToolCallOutput_Status.FAILED
            toolOutput.clientError = 'UpdateCells invoked without cells payload'
          }

          cells.forEach((updatedCell: Cell) => {
            try {
              if (!updatedCell?.refId) {
                console.warn('Received cell without refId', updatedCell)
                return
              }

              updateCell(updatedCell)
            } catch (error) {
              console.error(
                'Failed to process UpdateCell payload',
                error,
                updatedCell
              )
              toolOutput.status = ToolCallOutput_Status.FAILED
              toolOutput.clientError = `Failed to process UpdateCell payload: ${error}`
            }
          })

          toolOutput.output = {
            case: 'updateCells',
            value: create(UpdateCellsResponseSchema, {
              cells,
            }),
          }
          break
        }
        case GET_CELLS_TOOL: {
          console.log(`[ChatKit tool] ${invocation.name}`, decodedInput)
          if (inputCase !== 'getCells') {
            toolOutput.status = ToolCallOutput_Status.FAILED
            toolOutput.clientError =
              'GetCells tool invoked without getCells payload'
            break
          }

          const getCellsRequest = decodedInput.input.value
          if (!getCellsRequest) {
            toolOutput.status = ToolCallOutput_Status.FAILED
            toolOutput.clientError = 'GetCells request missing payload'
            break
          }

          const requestedRefs = getCellsRequest.refIds ?? []
          const foundCells = requestedRefs
            .map((id) => {
              const cell = cellMap.get(id)
              if (!cell) {
                console.warn(`Requested cell ${id} not found`)
              }
              return cell
            })
            .filter((cell): cell is Cell => Boolean(cell))

          toolOutput.output = {
            case: 'getCells',
            value: create(GetCellsResponseSchema, {
              cells: foundCells,
            }),
          }
          break
        }
        case LIST_CELLS_TOOL: {
          console.log(`[ChatKit tool] ${invocation.name}`, decodedInput)
          toolOutput.output = {
            case: 'listCells',
            value: create(ListCellsResponseSchema, {
              cells: orderedCells,
            }),
          }
          break
        }
        default: {
          toolOutput.status = ToolCallOutput_Status.FAILED
          toolOutput.clientError = `Unknown tool ${invocation.name}`
          return toJson(ToolCallOutputSchema, toolOutput) as Record<
            string,
            unknown
          >
        }
      }

      return toJson(ToolCallOutputSchema, toolOutput) as Record<string, unknown>
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

      console.error('ChatKit error', error)
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
      console.log('[chatkit] thread load start', JSON.stringify({ threadId }))
      appLogger.info('ChatKit thread load start', {
        attrs: {
          scope: 'chatkit.panel',
          adapter: defaultHarness.adapter,
          threadId,
        },
      })
    },
    onThreadLoadEnd: ({ threadId }) => {
      console.log('[chatkit] thread load end', JSON.stringify({ threadId }))
      appLogger.info('ChatKit thread load end', {
        attrs: {
          scope: 'chatkit.panel',
          adapter: defaultHarness.adapter,
          threadId,
        },
      })
    },
    onLog: ({ name, data }) => {
      console.log('[chatkit] log', JSON.stringify({ name, data }))
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
      const localChatkitState = getChatkitState()
      const codexSnapshot =
        defaultHarness.adapter === 'codex'
          ? getCodexConversationController().getSnapshot()
          : null
      const stack = new Error('chatkit thread change').stack ?? null
      appLogger.info('ChatKit thread changed', {
        attrs: {
          scope: 'chatkit.panel',
          adapter: defaultHarness.adapter,
          threadId: threadId ?? null,
          localThreadId: localChatkitState.threadId ?? null,
          localPreviousResponseId: localChatkitState.previousResponseId ?? null,
          codexCurrentThreadId: codexSnapshot?.currentThreadId ?? null,
          codexCurrentTurnId: codexSnapshot?.currentTurnId ?? null,
          stack,
        },
      })
      if (defaultHarness.adapter !== 'codex') {
        return
      }
      if (!threadId) {
        const codexThreadId = codexSnapshot?.currentThreadId
        if (codexThreadId) {
          const codexThread = codexConversation.threads.find(
            (thread) => thread.id === codexThreadId
          )
          appLogger.info(
            'Ignoring null ChatKit thread change while Codex thread is active',
            {
              attrs: {
                scope: 'chatkit.panel',
                adapter: defaultHarness.adapter,
                threadId: null,
                codexCurrentThreadId: codexThreadId,
                codexCurrentTurnId: codexSnapshot?.currentTurnId ?? null,
              },
            }
          )
          // setChatkitState(
          //   create(ChatkitStateSchema, {
          //     threadId: codexThreadId,
          //     previousResponseId: codexThread?.previousResponseId ?? "",
          //   }),
          // );
          return
        }
        // setChatkitState(create(ChatkitStateSchema, {}));
        return
      }
      const existing = codexConversation.threads.find(
        (thread) => thread.id === threadId
      )
      void existing
      // setChatkitState(
      //   create(ChatkitStateSchema, {
      //     threadId,
      //     previousResponseId: existing?.previousResponseId ?? "",
      //   }),
      // );
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

  const handleCodexNewChat = useCallback(async () => {
    const controller = getCodexConversationController()
    controller.startNewChat()
    setCodexStreamError(null)
    syncedCodexStateRef.current = {
      threadId: null,
      previousResponseId: null,
    }
    const thread = await controller.ensureActiveThread()
    // setChatkitState(
    //   create(ChatkitStateSchema, {
    //     threadId: thread.id,
    //     previousResponseId: thread.previousResponseId ?? "",
    //   }),
    // );
    syncedCodexStateRef.current = {
      threadId: thread.id,
      previousResponseId: thread.previousResponseId ?? null,
    }
    await chatkitActionsRef.current?.setThreadId(thread.id, 'new_chat')
  }, [])

  const handleCodexSelectThread = useCallback(async (threadId: string) => {
    const controller = getCodexConversationController()
    const thread = await controller.selectThread(threadId)
    // setChatkitState(
    //   create(ChatkitStateSchema, {
    //     threadId: thread.id,
    //     previousResponseId: thread.previousResponseId ?? "",
    //   }),
    // );
    syncedCodexStateRef.current = {
      threadId: thread.id,
      previousResponseId: thread.previousResponseId ?? null,
    }
    await chatkitActionsRef.current?.setThreadId(thread.id, 'select_thread')
    await chatkitActionsRef.current?.fetchUpdates('select_thread')
    setShowCodexDrawer(false)
  }, [])

  const handleCodexProjectChange = useCallback(async (projectId: string) => {
    const controller = getCodexConversationController()
    controller.setSelectedProject(projectId)
    controller.startNewChat()
    setCodexStreamError(null)
    syncedCodexStateRef.current = {
      threadId: null,
      previousResponseId: null,
    }
    await controller.refreshHistory()
    const thread = await controller.ensureActiveThread()
    // setChatkitState(
    //   create(ChatkitStateSchema, {
    //     threadId: thread.id,
    //     previousResponseId: thread.previousResponseId ?? "",
    //   }),
    // );
    syncedCodexStateRef.current = {
      threadId: thread.id,
      previousResponseId: thread.previousResponseId ?? null,
    }
    await chatkitActionsRef.current?.setThreadId(thread.id, 'project_change')
  }, [])

  const handleLogin = useCallback(() => {
    setShowLoginPrompt(false)
    getBrowserAdapter().loginWithRedirect()
  }, [])

  const handleDismissPrompt = useCallback(() => {
    setShowLoginPrompt(false)
  }, [])

  return (
    <div className="relative h-full w-full">
      {defaultHarness.adapter !== 'codex' || codexThreadBootstrapComplete ? (
        <ChatKit control={chatkit.control} className="block h-full w-full" />
      ) : (
        <div
          data-testid="codex-chatkit-bootstrap"
          className="flex h-full w-full items-center justify-center text-sm text-nb-text-muted"
        >
          Initializing Codex thread...
        </div>
      )}
      {defaultHarness.adapter === 'codex' && codexStreamError ? (
        <div
          data-testid="codex-stream-error"
          className="absolute left-3 right-3 top-3 z-30 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 shadow-sm"
        >
          {codexStreamError}
        </div>
      ) : null}
      {defaultHarness.adapter === 'codex' && showCodexDrawer ? (
        <div
          data-testid="codex-project-drawer"
          className="absolute inset-y-0 left-0 z-40 flex w-[280px] flex-col border-r border-nb-cell-border bg-white/95 shadow-lg"
        >
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
            <button
              type="button"
              className="mt-2 w-full rounded border border-nb-cell-border px-2 py-1 text-sm text-nb-text hover:bg-nb-surface-2"
              onClick={() => {
                void handleCodexNewChat()
              }}
            >
              New chat
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-nb-text-muted">
              Conversations
            </div>
            {codexConversation.loadingHistory ? (
              <div className="text-sm text-nb-text-muted">Loading...</div>
            ) : codexConversation.threads.length === 0 ? (
              <div className="text-sm text-nb-text-muted">
                No conversations yet.
              </div>
            ) : (
              <div className="space-y-2">
                {codexConversation.threads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    data-testid={`codex-thread-${thread.id}`}
                    className={`w-full rounded border px-2 py-2 text-left text-sm ${
                      codexConversation.currentThreadId === thread.id
                        ? 'border-nb-accent bg-nb-surface-2'
                        : 'border-nb-cell-border bg-white'
                    }`}
                    onClick={() => {
                      void handleCodexSelectThread(thread.id)
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
  const { defaultHarness } = useHarness()
  const harnessSessionKey = `${defaultHarness.name}:${defaultHarness.baseUrl}:${defaultHarness.adapter}`
  return (
    <ChatKitPanelInner
      key={harnessSessionKey}
      defaultHarness={defaultHarness}
    />
  )
}

export default ChatKitPanel
