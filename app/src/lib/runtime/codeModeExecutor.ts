import { appLogger } from '../logging/runtime'
import { createAppJsGlobals } from './appJsGlobals'
import { JSKernel } from './jsKernel'
import {
  type NotebookDataLike,
  createNotebooksApi,
  createRunmeConsoleApi,
} from './runmeConsole'
import { SandboxJSKernel } from './sandboxJsKernel'

export type CodeModeSource = 'chatkit' | 'codex'
export type CodeModeRunnerMode = 'browser' | 'sandbox'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_MAX_CODE_BYTES = 64 * 1024
const OUTPUT_TRUNCATED_SUFFIX = '\n[output truncated]\n'

export type CodeModeExecutionError = Error & { output: string }

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
  }): Promise<{ output: string }>
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
    execute: async ({ code, source }) => {
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
      const notebooksApi = createNotebooksApi({
        resolveNotebook,
        listNotebooks,
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
        sendOutput: appendOutput,
        resolveNotebook,
        listNotebooks,
      })

      const kernelRun =
        mode === 'sandbox'
          ? new SandboxJSKernel({
              hooks: {
                onStdout: appendOutput,
                onStderr: appendOutput,
              },
              bridge: {
                call: async (method, args) => {
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
                    case 'notebooks.help':
                      return notebooksApi.help(args[0] as any)
                    case 'notebooks.list':
                      return notebooksApi.list((args[0] as any) ?? undefined)
                    case 'notebooks.get':
                      return notebooksApi.get((args[0] as any) ?? undefined)
                    case 'notebooks.update':
                      return notebooksApi.update(
                        (args[0] as any) ?? { operations: [] }
                      )
                    case 'notebooks.delete':
                      return notebooksApi.delete(args[0] as any)
                    case 'notebooks.execute':
                      return notebooksApi.execute(
                        (args[0] as any) ?? { refIds: [] }
                      )
                    default:
                      throw new Error(
                        `Unsupported sandbox AppKernel method: ${method}`
                      )
                  }
                },
              },
            }).run(normalizedCode)
          : new JSKernel({
              globals,
              hooks: {
                onStdout: appendOutput,
                onStderr: appendOutput,
              },
            }).run(normalizedCode)

      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          kernelRun,
          new Promise<void>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`ExecuteCode timed out after ${timeoutMs}ms`))
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
      }
    },
  }
}
