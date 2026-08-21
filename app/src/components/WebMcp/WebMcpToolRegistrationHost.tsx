import { useEffect } from 'react'

import { appLogger } from '../../lib/logging/runtime'
import { getAppConsoleData } from '../../lib/appConsole/appConsoleController'
import {
  buildReadInstructionsForAIAgentsInputSchema,
  readInstructionsForAIAgents,
  READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_DESCRIPTION,
  READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_NAME,
  READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_TITLE,
} from '../../lib/runtime/aiAgentInstructions'
import {
  buildGetDocumentationInputSchema,
  buildListDocumentationInputSchema,
  getDocumentationForAgents,
  GET_DOCUMENTATION_TOOL_DESCRIPTION,
  GET_DOCUMENTATION_TOOL_NAME,
  GET_DOCUMENTATION_TOOL_TITLE,
  listDocumentationForAgents,
  LIST_DOCUMENTATION_TOOL_DESCRIPTION,
  LIST_DOCUMENTATION_TOOL_NAME,
  LIST_DOCUMENTATION_TOOL_TITLE,
} from '../../lib/runtime/documentationTools'
import {
  buildCancelExecuteCodeOperationInputSchema,
  buildExecuteCodeInputSchema,
  buildGetExecuteCodeOperationInputSchema,
  CANCEL_EXECUTE_CODE_OPERATION_TOOL_DESCRIPTION,
  CANCEL_EXECUTE_CODE_OPERATION_TOOL_NAME,
  CANCEL_EXECUTE_CODE_OPERATION_TOOL_TITLE,
  EXECUTE_CODE_TOOL_DESCRIPTION,
  EXECUTE_CODE_TOOL_NAME,
  EXECUTE_CODE_TOOL_TITLE,
  GET_EXECUTE_CODE_OPERATION_TOOL_DESCRIPTION,
  GET_EXECUTE_CODE_OPERATION_TOOL_NAME,
  GET_EXECUTE_CODE_OPERATION_TOOL_TITLE,
} from '../../lib/runtime/executeCodeTool'
import type {
  CancelExecuteCodeOperationInput,
  GetExecuteCodeOperationInput,
} from '../../lib/runtime/codeOperationTypes'
import { useCodeOperationRegistry } from '../../lib/runtime/useCodeOperationRegistry'
import { useCodeModeExecutor } from '../../lib/runtime/useCodeModeExecutor'
import {
  buildDismissTourInputSchema,
  buildShowTourStepInputSchema,
  DISMISS_TOUR_TOOL_DESCRIPTION,
  DISMISS_TOUR_TOOL_NAME,
  DISMISS_TOUR_TOOL_TITLE,
  executeDismissTour,
  executeShowTourStep,
  SHOW_TOUR_STEP_TOOL_DESCRIPTION,
  SHOW_TOUR_STEP_TOOL_NAME,
  SHOW_TOUR_STEP_TOOL_TITLE,
} from '../../lib/runtime/tourGuideTool'
import {
  buildCreateDriveNotebookInputSchema,
  CREATE_DRIVE_NOTEBOOK_TOOL_DESCRIPTION,
  CREATE_DRIVE_NOTEBOOK_TOOL_NAME,
  CREATE_DRIVE_NOTEBOOK_TOOL_TITLE,
  executeCreateDriveNotebook,
} from '../../lib/runtime/createDriveNotebookTool'
import { appState } from '../../lib/runtime/AppState'

type ToolExecuteOptionsLike = {
  signal?: AbortSignal
  // Legacy host extension. This is not part of the current WebMCP specification.
  requestUserInteraction?: (
    callback: () => Promise<unknown> | unknown
  ) => Promise<unknown>
}

type ModelContextLike = {
  registerTool: (
    tool: {
      name: string
      title: string
      description: string
      inputSchema: Record<string, unknown>
      annotations: {
        readOnlyHint: boolean
        untrustedContentHint: boolean
      }
      execute: (
        input: Record<string, unknown>,
        options: ToolExecuteOptionsLike
      ) => Promise<string> | string
    },
    options?: { signal?: AbortSignal }
  ) => Promise<undefined> | undefined
}

function getModelContext(): ModelContextLike | null {
  const documentModelContext =
    typeof document === 'undefined'
      ? undefined
      : (
          document as Document & {
            modelContext?: Partial<ModelContextLike>
          }
        ).modelContext
  if (typeof documentModelContext?.registerTool === 'function') {
    return documentModelContext as ModelContextLike
  }

  // Compatibility fallback for implementations of the earlier WebMCP draft.
  const navigatorModelContext =
    typeof navigator === 'undefined'
      ? undefined
      : (
          navigator as Navigator & {
            modelContext?: Partial<ModelContextLike>
          }
        ).modelContext
  if (typeof navigatorModelContext?.registerTool === 'function') {
    return navigatorModelContext as ModelContextLike
  }

  return null
}

function isDriveAuthorizationRequired(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('Google Drive authorization is required')
  )
}

async function executeCreateDriveNotebookWithAuthorization(
  input: Record<string, unknown>,
  options: ToolExecuteOptionsLike
): Promise<string> {
  try {
    // Preserve the no-UI path for cached tokens and service-account sessions.
    return await executeCreateDriveNotebook(input)
  } catch (error) {
    if (
      !isDriveAuthorizationRequired(error) ||
      typeof options.requestUserInteraction !== 'function'
    ) {
      throw error
    }

    const result = await options.requestUserInteraction(async () => {
      const authorization = await appState.startGoogleDriveOAuth({
        mode: 'popup',
      })
      if (authorization.status !== 'authorized') {
        throw new Error(
          'Google Drive authorization opened in a new tab. Complete authorization, then retry createDriveNotebook with the same idempotencyKey.'
        )
      }
      return executeCreateDriveNotebook(input)
    })

    if (typeof result !== 'string') {
      throw new Error('createDriveNotebook returned an invalid result')
    }
    return result
  }
}

export default function WebMcpToolRegistrationHost() {
  const codeModeExecutor = useCodeModeExecutor({ mode: 'sandbox' })
  const codeOperationRegistry = useCodeOperationRegistry(codeModeExecutor)
  const appConsoleData = getAppConsoleData()

  useEffect(() => {
    const modelContext = getModelContext()
    if (!modelContext) {
      appLogger.debug('WebMCP unavailable; skipping tool registration', {
        attrs: {
          scope: 'webmcp',
        },
      })
      return
    }

    const registrationController = new AbortController()
    const registrationPromises: Promise<undefined>[] = []

    const registerTool: ModelContextLike['registerTool'] = (tool, options) => {
      const result = modelContext.registerTool(tool, options)
      const registration = Promise.resolve(result)
      registrationPromises.push(registration)
      return registration
    }

    try {
      registerTool(
        {
          name: EXECUTE_CODE_TOOL_NAME,
          title: EXECUTE_CODE_TOOL_TITLE,
          description: EXECUTE_CODE_TOOL_DESCRIPTION,
          inputSchema: buildExecuteCodeInputSchema(),
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: true,
          },
          execute: async (input) => {
            const code =
              typeof input?.code === 'string'
                ? input.code
                : String(input?.code ?? '')
            await appConsoleData.hydrate()
            const executionState: {
              current: ReturnType<typeof appConsoleData.startExternalExecution>
            } = { current: null }

            try {
              const result = await codeOperationRegistry.start({
                code,
                ...(typeof input?.timeoutMs === 'number'
                  ? { timeoutMs: input.timeoutMs }
                  : {}),
                ...(input?.timeoutBehavior === 'cancel' ||
                input?.timeoutBehavior === 'continue'
                  ? { timeoutBehavior: input.timeoutBehavior }
                  : {}),
                ...(typeof input?.maxRuntimeMs === 'number'
                  ? { maxRuntimeMs: input.maxRuntimeMs }
                  : {}),
                ...(typeof input?.idempotencyKey === 'string'
                  ? { idempotencyKey: input.idempotencyKey }
                  : {}),
                onAccepted: () => {
                  executionState.current =
                    appConsoleData.startExternalExecution(code)
                },
                hooks: {
                  onStdout: (chunk) => {
                    const execution = executionState.current
                    if (execution) {
                      appConsoleData.appendStdout(execution.cellId, chunk)
                    }
                  },
                  onStderr: (chunk) => {
                    const execution = executionState.current
                    if (execution) {
                      appConsoleData.appendStderr(execution.cellId, chunk)
                    }
                  },
                },
                onSettled: (operation) => {
                  const execution = executionState.current
                  if (!execution) {
                    return
                  }
                  if (operation.status === 'succeeded') {
                    appConsoleData.completeExecution(execution.cellId, {
                      exitCode: operation.exitCode ?? 0,
                    })
                    return
                  }
                  appConsoleData.failExecution(execution.cellId, {
                    exitCode: operation.exitCode ?? 1,
                    message:
                      operation.error?.message ??
                      `ExecuteCode operation ended with status ${operation.status}.`,
                  })
                },
              })
              return JSON.stringify(result)
            } catch (error) {
              const execution = executionState.current
              if (execution) {
                appConsoleData.failExecution(execution.cellId, {
                  message:
                    error instanceof Error ? error.message : String(error),
                })
              }
              throw error
            }
          },
        },
        {
          signal: registrationController.signal,
        }
      )
      registerTool(
        {
          name: GET_EXECUTE_CODE_OPERATION_TOOL_NAME,
          title: GET_EXECUTE_CODE_OPERATION_TOOL_TITLE,
          description: GET_EXECUTE_CODE_OPERATION_TOOL_DESCRIPTION,
          inputSchema: buildGetExecuteCodeOperationInputSchema(),
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: true,
          },
          execute: async (input) =>
            JSON.stringify(
              await codeOperationRegistry.get(
                input as GetExecuteCodeOperationInput
              )
            ),
        },
        {
          signal: registrationController.signal,
        }
      )
      registerTool(
        {
          name: CANCEL_EXECUTE_CODE_OPERATION_TOOL_NAME,
          title: CANCEL_EXECUTE_CODE_OPERATION_TOOL_TITLE,
          description: CANCEL_EXECUTE_CODE_OPERATION_TOOL_DESCRIPTION,
          inputSchema: buildCancelExecuteCodeOperationInputSchema(),
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: true,
          },
          execute: async (input) =>
            JSON.stringify(
              await codeOperationRegistry.cancel(
                input as CancelExecuteCodeOperationInput
              )
            ),
        },
        {
          signal: registrationController.signal,
        }
      )
      registerTool(
        {
          name: READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_NAME,
          title: READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_TITLE,
          description: READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_DESCRIPTION,
          inputSchema: buildReadInstructionsForAIAgentsInputSchema(),
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: false,
          },
          execute: () => readInstructionsForAIAgents(window.location.origin),
        },
        {
          signal: registrationController.signal,
        }
      )
      registerTool(
        {
          name: LIST_DOCUMENTATION_TOOL_NAME,
          title: LIST_DOCUMENTATION_TOOL_TITLE,
          description: LIST_DOCUMENTATION_TOOL_DESCRIPTION,
          inputSchema: buildListDocumentationInputSchema(),
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: false,
          },
          execute: () => listDocumentationForAgents(),
        },
        {
          signal: registrationController.signal,
        }
      )
      registerTool(
        {
          name: GET_DOCUMENTATION_TOOL_NAME,
          title: GET_DOCUMENTATION_TOOL_TITLE,
          description: GET_DOCUMENTATION_TOOL_DESCRIPTION,
          inputSchema: buildGetDocumentationInputSchema(),
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: false,
          },
          execute: (input) =>
            getDocumentationForAgents(
              typeof input?.name === 'string' ? input.name : ''
            ),
        },
        {
          signal: registrationController.signal,
        }
      )
      registerTool(
        {
          name: SHOW_TOUR_STEP_TOOL_NAME,
          title: SHOW_TOUR_STEP_TOOL_TITLE,
          description: SHOW_TOUR_STEP_TOOL_DESCRIPTION,
          inputSchema: buildShowTourStepInputSchema(),
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: false,
          },
          execute: (input) => executeShowTourStep(input),
        },
        {
          signal: registrationController.signal,
        }
      )
      registerTool(
        {
          name: DISMISS_TOUR_TOOL_NAME,
          title: DISMISS_TOUR_TOOL_TITLE,
          description: DISMISS_TOUR_TOOL_DESCRIPTION,
          inputSchema: buildDismissTourInputSchema(),
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: false,
          },
          execute: () => executeDismissTour(),
        },
        {
          signal: registrationController.signal,
        }
      )
      registerTool(
        {
          name: CREATE_DRIVE_NOTEBOOK_TOOL_NAME,
          title: CREATE_DRIVE_NOTEBOOK_TOOL_TITLE,
          description: CREATE_DRIVE_NOTEBOOK_TOOL_DESCRIPTION,
          inputSchema: buildCreateDriveNotebookInputSchema(),
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: false,
          },
          execute: (input, options) =>
            executeCreateDriveNotebookWithAuthorization(input, options),
        },
        {
          signal: registrationController.signal,
        }
      )
      void Promise.all(registrationPromises)
        .then(() => {
          if (registrationController.signal.aborted) {
            return
          }
          appLogger.info('WebMCP tools registered', {
            attrs: {
              scope: 'webmcp',
              toolNames: [
                EXECUTE_CODE_TOOL_NAME,
                GET_EXECUTE_CODE_OPERATION_TOOL_NAME,
                CANCEL_EXECUTE_CODE_OPERATION_TOOL_NAME,
                READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_NAME,
                LIST_DOCUMENTATION_TOOL_NAME,
                GET_DOCUMENTATION_TOOL_NAME,
                SHOW_TOUR_STEP_TOOL_NAME,
                DISMISS_TOUR_TOOL_NAME,
                CREATE_DRIVE_NOTEBOOK_TOOL_NAME,
              ],
            },
          })
        })
        .catch((error) => {
          if (registrationController.signal.aborted) {
            return
          }
          registrationController.abort(error)
          appLogger.error('Failed to register WebMCP tools', {
            attrs: {
              scope: 'webmcp',
              error: String(error),
            },
          })
        })
    } catch (error) {
      registrationController.abort()
      appLogger.error('Failed to register WebMCP tools', {
        attrs: {
          scope: 'webmcp',
          error: String(error),
        },
      })
      return
    }

    return () => {
      registrationController.abort()
      appLogger.info('WebMCP tools unregistered', {
        attrs: {
          scope: 'webmcp',
          toolNames: [
            EXECUTE_CODE_TOOL_NAME,
            GET_EXECUTE_CODE_OPERATION_TOOL_NAME,
            CANCEL_EXECUTE_CODE_OPERATION_TOOL_NAME,
            READ_INSTRUCTIONS_FOR_AI_AGENTS_TOOL_NAME,
            LIST_DOCUMENTATION_TOOL_NAME,
            GET_DOCUMENTATION_TOOL_NAME,
            SHOW_TOUR_STEP_TOOL_NAME,
            DISMISS_TOUR_TOOL_NAME,
            CREATE_DRIVE_NOTEBOOK_TOOL_NAME,
          ],
        },
      })
    }
  }, [appConsoleData, codeOperationRegistry])

  return null
}
