import { appLogger } from '../logging/runtime'
import { createAppJsGlobals } from './appJsGlobals'
import {
  createAppKernelNetworkApi,
  createAppKernelOpfsApi,
} from './appKernelLowLevelApis'
import { getCodexTurnEvents, listCodexTurns } from './codexTurns'
import { createNotebookDiffRuntimeApi } from '../notebookDiff/runtime'
import { JSKernel } from './jsKernel'
import {
  type NotebooksApiBridgeServer,
  createHostNotebooksApi,
  createNotebooksApiBridgeServer,
} from './notebooksApiBridge'
import { type NotebookDataLike, createRunmeConsoleApi } from './runmeConsole'
import { appState } from './AppState'
import {
  CODE_MODE_SANDBOX_ALLOWED_METHODS,
  SandboxJSKernel,
} from './sandboxJsKernel'

export type CodeModeSource = 'chatkit' | 'codex' | 'webmcp'
export type CodeModeRunnerMode = 'browser' | 'sandbox'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_MAX_CODE_BYTES = 64 * 1024
const OUTPUT_TRUNCATED_SUFFIX = '\n[output truncated]\n'

export type CodeModeExecutionError = Error & { output: string }
export type CodeModeExecutionHooks = {
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

function withOutput(error: unknown, output: string): CodeModeExecutionError {
  const err = error instanceof Error ? error : new Error(String(error))
  const typed = err as CodeModeExecutionError
  typed.output = output
  return typed
}

export function getCodeModeErrorOutput(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return ''
  }
  const output = (error as { output?: unknown }).output
  return typeof output === 'string' ? output : ''
}

export type CodeModeExecutor = {
  execute(args: {
    code: string
    source: CodeModeSource
    hooks?: CodeModeExecutionHooks
  }): Promise<{ output: string; exitCode: number }>
}

export function createCodeModeExecutor(options: {
  mode?: CodeModeRunnerMode
  timeoutMs?: number
  maxOutputBytes?: number
  maxCodeBytes?: number
  resolveNotebook: (target?: unknown) => NotebookDataLike | null
  listNotebooks?: () => NotebookDataLike[]
}): CodeModeExecutor {
  const mode = options.mode ?? 'sandbox'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const maxCodeBytes = options.maxCodeBytes ?? DEFAULT_MAX_CODE_BYTES

  const resolveNotebook = options.resolveNotebook
  const listNotebooks =
    options.listNotebooks ??
    (() => {
      const current = resolveNotebook()
      return current ? [current] : []
    })

  return {
    execute: async ({ code, source, hooks }) => {
      const normalizedCode =
        typeof code === 'string' ? code : String(code ?? '')
      const codeBytes = new TextEncoder().encode(normalizedCode).length
      if (codeBytes > maxCodeBytes) {
        throw withOutput(
          new Error(
            `ExecuteCode rejected code payload larger than ${maxCodeBytes} bytes`
          ),
          ''
        )
      }

      appLogger.info('Code mode execution started', {
        attrs: {
          scope: 'chatkit.code_mode',
          source,
          mode,
          timeoutMs,
          maxOutputBytes,
          maxCodeBytes,
          code: normalizedCode,
          codeBytes,
        },
      })

      const runmeApi = createRunmeConsoleApi({
        resolveNotebook,
      })
      const opfsApi = createAppKernelOpfsApi()
      const networkApi = createAppKernelNetworkApi()
      const hostNotebooksApi = createHostNotebooksApi({
        resolveNotebook,
        listNotebooks,
      })
      const notebooksApiBridgeServer = createNotebooksApiBridgeServer({
        notebooksApi: hostNotebooksApi,
      })
      const notebookDiffApi = createNotebookDiffRuntimeApi({
        notebooksApi: hostNotebooksApi,
        resolveLocalNotebooks: () => appState.localNotebooks,
        resolveDriveNotebookStore: () => appState.driveNotebookStore,
      })

      const chunks: string[] = []
      let outputBytes = 0
      let truncated = false

      const appendOutput = (data: string) => {
        if (truncated || !data) {
          return
        }
        const bytes = new TextEncoder().encode(data)
        if (outputBytes + bytes.length <= maxOutputBytes) {
          chunks.push(data)
          outputBytes += bytes.length
          return
        }
        const remaining = Math.max(0, maxOutputBytes - outputBytes)
        if (remaining > 0) {
          const clipped = data.slice(0, remaining)
          chunks.push(clipped)
        }
        chunks.push(OUTPUT_TRUNCATED_SUFFIX)
        outputBytes = maxOutputBytes
        truncated = true
      }

      const globals = createAppJsGlobals({
        runme: runmeApi,
        sendOutput: (data) => {
          appendOutput(data)
          hooks?.onStdout?.(data)
        },
        resolveNotebook,
        listNotebooks,
        opfsApi,
        networkApi,
      })

      const abortController = new AbortController()
      let finalExitCode = 0
      const kernelRun =
        mode === 'sandbox'
          ? new SandboxJSKernel({
              hooks: {
                onStdout: (data) => {
                  appendOutput(data)
                  hooks?.onStdout?.(data)
                },
                onStderr: (data) => {
                  appendOutput(data)
                  hooks?.onStderr?.(data)
                },
                onExit: (exitCode) => {
                  finalExitCode = exitCode
                },
              },
              allowedMethods: CODE_MODE_SANDBOX_ALLOWED_METHODS,
              bridge: {
                call: (method, args) =>
                  handleSandboxAppKernelBridgeCall({
                    method,
                    args,
                    runmeApi,
                    opfsApi,
                    networkApi,
                    notebooksApiBridgeServer,
                    notebookDiffApi,
                  }),
              },
            }).run(normalizedCode, { signal: abortController.signal })
          : new JSKernel({
              globals,
              hooks: {
                onStdout: (data) => {
                  appendOutput(data)
                  hooks?.onStdout?.(data)
                },
                onStderr: (data) => {
                  appendOutput(data)
                  hooks?.onStderr?.(data)
                },
                onExit: (exitCode) => {
                  finalExitCode = exitCode
                },
              },
            }).run(normalizedCode)

      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          kernelRun,
          new Promise<void>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`ExecuteCode timed out after ${timeoutMs}ms`))
              abortController.abort()
            }, timeoutMs)
          }),
        ])
      } catch (error) {
        const output = chunks.join('')
        appLogger.error('Code mode execution failed', {
          attrs: {
            scope: 'chatkit.code_mode',
            source,
            mode,
            timeoutMs,
            maxOutputBytes,
            code: normalizedCode,
            output,
            error: String(error),
          },
        })
        throw withOutput(error, output)
      } finally {
        if (timer) {
          clearTimeout(timer)
        }
      }

      const output = chunks.join('')
      appLogger.info('Code mode execution completed', {
        attrs: {
          scope: 'chatkit.code_mode',
          source,
          mode,
          code: normalizedCode,
          output,
          outputBytes,
          truncated,
        },
      })

      return {
        output,
        exitCode: finalExitCode,
      }
    },
  }
}

async function handleSandboxAppKernelBridgeCall({
  method,
  args,
  runmeApi,
  opfsApi,
  networkApi,
  notebooksApiBridgeServer,
  notebookDiffApi,
}: {
  method: string
  args: unknown[]
  runmeApi: ReturnType<typeof createRunmeConsoleApi>
  opfsApi: ReturnType<typeof createAppKernelOpfsApi>
  networkApi: ReturnType<typeof createAppKernelNetworkApi>
  notebooksApiBridgeServer: NotebooksApiBridgeServer
  notebookDiffApi: ReturnType<typeof createNotebookDiffRuntimeApi>
}): Promise<unknown> {
  const target = args[0]
  switch (method) {
    case 'runme.clear':
      return runmeApi.clear(target)
    case 'runme.clearOutputs':
      return runmeApi.clearOutputs(target)
    case 'runme.runAll':
      return runmeApi.runAll(target)
    case 'runme.rerun':
      return runmeApi.rerun(target)
    case 'runme.help':
      return runmeApi.help()
    case 'opfs.exists':
      return opfsApi.exists(String(args[0] ?? ''))
    case 'opfs.readText':
      return opfsApi.readText(String(args[0] ?? ''))
    case 'opfs.writeText':
      return opfsApi.writeText(String(args[0] ?? ''), String(args[1] ?? ''))
    case 'opfs.readBytes':
      return opfsApi.readBytes(String(args[0] ?? ''))
    case 'opfs.writeBytes': {
      const bytesArg = args[1]
      const bytes =
        bytesArg instanceof Uint8Array
          ? bytesArg
          : Array.isArray(bytesArg)
            ? new Uint8Array(bytesArg)
            : new Uint8Array()
      return opfsApi.writeBytes(String(args[0] ?? ''), bytes)
    }
    case 'opfs.list':
      return opfsApi.list(String(args[0] ?? ''))
    case 'opfs.mkdir':
      return opfsApi.mkdir(
        String(args[0] ?? ''),
        args[1] as {
          recursive?: boolean
        }
      )
    case 'opfs.stat':
      return opfsApi.stat(String(args[0] ?? ''))
    case 'opfs.remove':
      return opfsApi.remove(
        String(args[0] ?? ''),
        args[1] as {
          recursive?: boolean
        }
      )
    case 'net.get':
      return networkApi.get(
        String(args[0] ?? ''),
        (args[1] as {
          headers?: Record<string, string>
          responseType?: 'text' | 'bytes' | 'json'
        }) ?? undefined
      )
    case 'runme.getCurrentNotebook': {
      const notebook = runmeApi.getCurrentNotebook()
      if (!notebook) {
        return null
      }
      return {
        uri: notebook.getUri(),
        name: notebook.getName(),
        cellCount: notebook.getNotebook().cells.length,
      }
    }
    case 'codex.turns.list':
      return await listCodexTurns()
    case 'codex.turns.getEvents':
      return await getCodexTurnEvents(
        String(args[0] ?? ''),
        (args[1] as { sessionId?: string }) ?? undefined
      )
    case 'notebookDiff.listDriveRevisions':
      return notebookDiffApi.listDriveRevisions(args[0] as any)
    case 'notebookDiff.diffDriveRevision':
      return notebookDiffApi.diffDriveRevision(args[0] as any)
    case 'notebookDiff.openDiffTab':
      return notebookDiffApi.openDiffTab(args[0] as any)
    case 'notebookDiff.help':
      return notebookDiffApi.help()
    default:
      if (method.startsWith('notebooks.')) {
        return notebooksApiBridgeServer.handleMessage({
          method,
          args,
        })
      }
      throw new Error(`Unsupported sandbox AppKernel method: ${method}`)
  }
}
