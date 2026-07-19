import { googleClientManager } from '../googleClientManager'
import { appLogger } from '../logging/runtime'
import { createNotebookDiffRuntimeApi } from '../notebookDiff/runtime'
import { getClaimedSessionId } from '../tabIdentity'
import {
  createDriveFile,
  listDriveFolderItems,
  saveNotebookAsDriveCopy,
  searchDriveFiles,
  updateDriveFileBytes,
} from '../driveTransfer'
import { appState } from './AppState'
import { createAppJsGlobals } from './appJsGlobals'
import {
  createAppKernelNetworkApi,
  createAppKernelOpfsApi,
} from './appKernelLowLevelApis'
import { getCodexTurnEvents, listCodexTurns } from './codexTurns'
import { JSKernel } from './jsKernel'
import {
  type NotebooksApiBridgeServer,
  createHostNotebooksApi,
  createNotebooksApiBridgeServer,
} from './notebooksApiBridge'
import { type NotebookDataLike, createRunmeConsoleApi } from './runmeConsole'
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
const LOCAL_SERVICE_ACCOUNT_KEY_ENDPOINT = '/__runme-dev/service-account-key'

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

async function readServiceAccountJsonFromLocalPath(
  keyPath: string
): Promise<{ name: string; text: string }> {
  const trimmedPath = keyPath.trim()
  if (!trimmedPath) {
    throw new Error('Google service account key path is required.')
  }
  const url = new URL(
    LOCAL_SERVICE_ACCOUNT_KEY_ENDPOINT,
    window.location.origin
  )
  url.searchParams.set('path', trimmedPath)
  const response = await fetch(url.toString(), { cache: 'no-store' })
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(
      `Failed to read service account key from local dev server (${response.status}): ${responseText}`
    )
  }
  const parsed = JSON.parse(responseText) as {
    name?: string
    text?: string
  }
  if (!parsed.text) {
    throw new Error(
      'Local dev server did not return service account JSON text.'
    )
  }
  return {
    name: parsed.name || trimmedPath.split('/').pop() || 'service-account.json',
    text: parsed.text,
  }
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
      const notebookDiffApi = createNotebookDiffRuntimeApi({
        notebooksApi: hostNotebooksApi,
        resolveLocalNotebooks: () => appState.localNotebooks,
        resolveDriveNotebookStore: () => appState.driveNotebookStore,
        resolveNotebook,
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

      const abortController = new AbortController()
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
        signal: abortController.signal,
      })
      const notebooksApiBridgeServer = createNotebooksApiBridgeServer({
        notebooksApi: globals.notebooks as typeof hostNotebooksApi,
      })

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
                    globals,
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
  globals,
  notebooksApiBridgeServer,
  notebookDiffApi,
}: {
  method: string
  args: unknown[]
  runmeApi: ReturnType<typeof createRunmeConsoleApi>
  opfsApi: ReturnType<typeof createAppKernelOpfsApi>
  networkApi: ReturnType<typeof createAppKernelNetworkApi>
  globals: ReturnType<typeof createAppJsGlobals>
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
    case 'app.getSessionId':
      return getClaimedSessionId()
    case 'app.getSessionID':
      return getClaimedSessionId()
    case 'embed':
      return globals.embed(
        args[0] as Parameters<typeof globals.embed>[0],
        (args[1] as
          | { target?: unknown; alt?: string; name?: string }
          | undefined) ?? undefined
      )
    case 'app.startGoogleDriveOAuth':
    case 'drive.authorize':
    case 'drive.refreshAuth': {
      const result = await appState.startGoogleDriveOAuth(
        args[0] as
          | {
              mode?: 'popup' | 'redirect' | 'new_tab'
              prompt?: 'none' | 'consent'
            }
          | undefined
      )
      return {
        status: result.status,
        authFlow: result.authFlow,
        mode: result.mode,
        ...(result.accessToken ? { accessToken: '<redacted>' } : {}),
      }
    }
    case 'explorer.mountDrive':
      return globals.explorer.mountDrive(String(args[0] ?? ''))
    case 'explorer.removeFolder':
      return globals.explorer.removeFolder(String(args[0] ?? ''))
    case 'explorer.editName':
      return globals.explorer.editName(String(args[0] ?? ''))
    case 'explorer.renameFolder':
      return globals.explorer.renameFolder(
        String(args[0] ?? ''),
        String(args[1] ?? '')
      )
    case 'explorer.listFolders':
      return globals.explorer.listFolders()
    case 'credentials.google.setServiceAccountFromFilePath': {
      const selection = await readServiceAccountJsonFromLocalPath(
        String(args[0] ?? '')
      )
      const config = googleClientManager.setOAuthClientFromJson(selection.text)
      if (config.authFlow !== 'service_account') {
        throw new Error(
          `Selected JSON file (${selection.name}) did not contain Google service account credentials.`
        )
      }
      return {
        authFlow: config.authFlow,
        authUxMode: config.authUxMode,
        clientId: config.clientId,
        serviceAccount: config.serviceAccount
          ? {
              clientEmail: config.serviceAccount.clientEmail,
              privateKeyId: config.serviceAccount.privateKeyId,
              tokenUri: config.serviceAccount.tokenUri,
              subject: config.serviceAccount.subject,
              scopes: config.serviceAccount.scopes,
            }
          : undefined,
      }
    }
    case 'drive.list':
      return listDriveFolderItems(String(args[0] ?? ''))
    case 'drive.search':
      return searchDriveFiles(args[0] as Record<string, unknown>)
    case 'drive.create':
      return createDriveFile(String(args[0] ?? ''), String(args[1] ?? ''))
    case 'drive.update': {
      const bytesArg = args[1]
      const bytes =
        bytesArg instanceof Uint8Array
          ? bytesArg
          : Array.isArray(bytesArg)
            ? new Uint8Array(bytesArg)
            : bytesArg instanceof ArrayBuffer
              ? new Uint8Array(bytesArg)
              : new Uint8Array()
      return updateDriveFileBytes(String(args[0] ?? ''), bytes)
    }
    case 'drive.saveAsCurrentNotebook': {
      const notebook = runmeApi.getCurrentNotebook()
      if (!notebook) {
        throw new Error('No active notebook handle available.')
      }
      return saveNotebookAsDriveCopy(
        notebook.getNotebook(),
        String(args[0] ?? ''),
        String(args[1] ?? '')
      )
    }
    case 'documents.get':
      return globals.documents.get(String(args[0] ?? ''))
    case 'documents.update':
      return globals.documents.update(
        String(args[0] ?? ''),
        String(args[1] ?? ''),
        (args[2] as {
          mimeType?: string
          expectedVersion?: string
          flush?: boolean
        }) ?? undefined
      )
    case 'notebookDiff.listDriveRevisions':
      return notebookDiffApi.listDriveRevisions(args[0] as any)
    case 'notebookDiff.diffDriveRevision':
      return notebookDiffApi.diffDriveRevision(args[0] as any)
    case 'notebookDiff.openDiffTab':
      return notebookDiffApi.openDiffTab(args[0] as any)
    case 'notebookDiff.openConflictDiff':
      return notebookDiffApi.openConflictDiff(args[0] as any)
    case 'notebookDiff.listConflictCells':
      return notebookDiffApi.listConflictCells(args[0] as any)
    case 'notebookDiff.restoreDeletedCell':
      return notebookDiffApi.restoreDeletedCell(args[0] as any)
    case 'notebookDiff.restoreAllDeletedCells':
      return notebookDiffApi.restoreAllDeletedCells(args[0] as any)
    case 'notebookDiff.help':
      return notebookDiffApi.help()
    default:
      if (method === 'notebooks.createLocal') {
        return (globals.notebooks as any).createLocal(args[0], args[1])
      }
      if (method === 'notebooks.appendCell') {
        return (globals.notebooks as any).appendCell(args[0])
      }
      if (method === 'notebooks.embed') {
        return (globals.notebooks as any).embed(args[0], args[1])
      }
      if (method.startsWith('notebooks.')) {
        return notebooksApiBridgeServer.handleMessage({
          method,
          args,
        })
      }
      throw new Error(`Unsupported sandbox AppKernel method: ${method}`)
  }
}
