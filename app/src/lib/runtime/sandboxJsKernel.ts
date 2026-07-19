import { appLogger } from '../logging/runtime'
import { SANDBOX_NOTEBOOKS_API_METHODS } from './notebooksApiBridge'
import { makeJsonSafe } from './runmeConsole'

type KernelHooks = {
  onStdout?: (data: string) => void
  onStderr?: (data: string) => void
  onExit?: (exitCode: number) => void
}

type RunOptions = {
  signal?: AbortSignal | null
}

type SandboxBridge = {
  call: (method: string, args: unknown[]) => Promise<unknown> | unknown
}

type SerializedHostError = {
  name: string
  message: string
  code?: string
  details?: unknown
}

type SandboxMessage =
  | { type: 'ready' }
  | { type: 'stdout'; data?: string }
  | { type: 'stderr'; data?: string }
  | { type: 'exit'; exitCode?: number }
  | { type: 'host-call'; callId?: number; method?: string; args?: unknown[] }

type SandboxSession = {
  iframe: HTMLIFrameElement
  port: MessagePort
  dispose: () => void
}

const SANDBOX_INIT_MESSAGE = 'runme-appkernel-sandbox-init'
const LOAD_TIMEOUT_MS = 3_000
const READY_TIMEOUT_MS = 3_000

function serializeHostError(error: unknown): string | SerializedHostError {
  const message = error instanceof Error ? error.message : String(error)
  if (!error || typeof error !== 'object') {
    return message
  }

  const candidate = error as {
    name?: unknown
    code?: unknown
    details?: unknown
  }
  if (typeof candidate.code !== 'string' && candidate.details === undefined) {
    return message
  }

  return makeJsonSafe({
    name: typeof candidate.name === 'string' ? candidate.name : 'Error',
    message,
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(candidate.details !== undefined ? { details: candidate.details } : {}),
  })
}

const DEFAULT_SANDBOX_ALLOWED_METHODS = [
  'runme.clear',
  'runme.clearOutputs',
  'runme.runAll',
  'runme.rerun',
  'runme.getCurrentNotebook',
  'runme.help',
  'notebookDiff.listDriveRevisions',
  'notebookDiff.diffDriveRevision',
  'notebookDiff.openDiffTab',
  'notebookDiff.openConflictDiff',
  'notebookDiff.listConflictCells',
  'notebookDiff.restoreDeletedCell',
  'notebookDiff.restoreAllDeletedCells',
  'notebookDiff.help',
  'app.getSessionId',
  'app.getSessionID',
  'app.startGoogleDriveOAuth',
  'explorer.mountDrive',
  'explorer.removeFolder',
  'explorer.editName',
  'explorer.renameFolder',
  'explorer.listFolders',
  'credentials.google.setServiceAccountFromFilePath',
  'drive.authorize',
  'drive.refreshAuth',
  'drive.list',
  'drive.search',
  'drive.create',
  'drive.update',
  'drive.saveAsCurrentNotebook',
  'documents.get',
  'documents.update',
  ...SANDBOX_NOTEBOOKS_API_METHODS,
  'notebooks.createLocal',
  'notebooks.appendCell',
]

const LOW_LEVEL_SANDBOX_ALLOWED_METHODS = [
  'opfs.exists',
  'opfs.readText',
  'opfs.writeText',
  'opfs.readBytes',
  'opfs.writeBytes',
  'opfs.list',
  'opfs.mkdir',
  'opfs.stat',
  'opfs.remove',
  'net.get',
]

export const CODE_MODE_SANDBOX_ALLOWED_METHODS = [
  ...DEFAULT_SANDBOX_ALLOWED_METHODS,
  ...LOW_LEVEL_SANDBOX_ALLOWED_METHODS,
]

function buildSandboxSrcDoc(options: {
  enableOpfs: boolean
  enableNet: boolean
}): string {
  const opfsHelper = options.enableOpfs
    ? `
        const opfs = {
          exists: (path) => hostCall("opfs.exists", [path]),
          readText: (path) => hostCall("opfs.readText", [path]),
          writeText: (path, text) => hostCall("opfs.writeText", [path, text]),
          readBytes: (path) => hostCall("opfs.readBytes", [path]),
          writeBytes: (path, bytes) => hostCall("opfs.writeBytes", [path, bytes]),
          list: (path) => hostCall("opfs.list", [path]),
          mkdir: (path, options) => hostCall("opfs.mkdir", [path, options]),
          stat: (path) => hostCall("opfs.stat", [path]),
          remove: (path, options) => hostCall("opfs.remove", [path, options]),
          help: () => {
            consoleProxy.log("opfs.exists(path)");
            consoleProxy.log("opfs.readText(path)");
            consoleProxy.log("opfs.writeText(path, text)");
            consoleProxy.log("opfs.readBytes(path)");
            consoleProxy.log("opfs.writeBytes(path, bytes)");
            consoleProxy.log("opfs.list(path)");
            consoleProxy.log("opfs.mkdir(path, { recursive? })");
            consoleProxy.log("opfs.stat(path)");
            consoleProxy.log("opfs.remove(path, { recursive? })");
            consoleProxy.log("opfs.help()");
          },
        };
      `
    : 'const opfs = undefined;'

  const netHelper = options.enableNet
    ? `
        const net = {
          get: (url, options) => hostCall("net.get", [url, options]),
          help: () => {
            consoleProxy.log("net.get(url, { headers?, responseType? })");
            consoleProxy.log("net.help()");
          },
        };
      `
    : 'const net = undefined;'

  const opfsHelpLines = options.enableOpfs
    ? `
          consoleProxy.log("- opfs.exists(path)");
          consoleProxy.log("- opfs.readText(path)");
          consoleProxy.log("- opfs.writeText(path, text)");
          consoleProxy.log("- opfs.readBytes(path)");
          consoleProxy.log("- opfs.writeBytes(path, bytes)");
          consoleProxy.log("- opfs.list(path)");
          consoleProxy.log("- opfs.mkdir(path, { recursive? })");
          consoleProxy.log("- opfs.stat(path)");
          consoleProxy.log("- opfs.remove(path, { recursive? })");
          consoleProxy.log("- opfs.help()");
      `
    : ''

  const netHelpLines = options.enableNet
    ? `
          consoleProxy.log("- net.get(url, { headers?, responseType? })");
          consoleProxy.log("- net.help()");
      `
    : ''

  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <script>
      (() => {
        let port = null;
        let callCounter = 0;
        const pending = new Map();

        const formatArgs = (args) =>
          args
            .map((value) => {
              if (typeof value === "string") {
                return value;
              }
              try {
                return JSON.stringify(
                  value,
                  (_key, item) => (typeof item === "bigint" ? item.toString() : item),
                );
              } catch {
                return String(value);
              }
            })
            .join(" ") + "\\n";

        const formatTableCell = (value) => {
          if (value === undefined) {
            return "";
          }
          if (typeof value === "bigint") {
            return value.toString();
          }
          if (value && typeof value === "object") {
            try {
              return JSON.stringify(
                value,
                (_key, item) => (typeof item === "bigint" ? item.toString() : item),
              );
            } catch {
              return String(value);
            }
          }
          return String(value);
        };

        const formatTable = (data, columns) => {
          if (!Array.isArray(data)) {
            return formatArgs([data]);
          }
          const normalizedRows = data.map((row, index) => {
            if (row && typeof row === "object" && !Array.isArray(row)) {
              return { index, values: row };
            }
            return { index, values: { value: row } };
          });
          const selectedColumns = Array.isArray(columns) && columns.length > 0
            ? columns
            : Array.from(
                normalizedRows.reduce((seen, row) => {
                  Object.keys(row.values).forEach((key) => seen.add(key));
                  return seen;
                }, new Set()),
              );
          const headers = ["(index)", ...selectedColumns];
          const lines = [
            headers.join("\\t"),
            ...normalizedRows.map((row) =>
              [row.index, ...selectedColumns.map((key) => row.values[key])]
                .map(formatTableCell)
                .join("\\t"),
            ),
          ];
          return lines.join("\\n") + "\\n";
        };

        const post = (payload) => {
          if (!port) {
            return;
          }
          port.postMessage(payload);
        };

        const hostCall = (method, args = []) =>
          new Promise((resolve, reject) => {
            if (!port) {
              reject(new Error("Sandbox host bridge is unavailable."));
              return;
            }
            callCounter += 1;
            const callId = callCounter;
            pending.set(callId, { resolve, reject });
            post({ type: "host-call", callId, method, args });
          });

        const createHostError = (payload) => {
          if (payload && typeof payload === "object") {
            const error = new Error(String(payload.message ?? "Host call failed"));
            if (typeof payload.name === "string") {
              error.name = payload.name;
            }
            if (typeof payload.code === "string") {
              error.code = payload.code;
            }
            if ("details" in payload) {
              error.details = payload.details;
            }
            return error;
          }
          return new Error(String(payload ?? "Host call failed"));
        };

        const consoleProxy = {
          log: (...args) => post({ type: "stdout", data: formatArgs(args) }),
          info: (...args) => post({ type: "stdout", data: formatArgs(args) }),
          table: (data, columns) => post({ type: "stdout", data: formatTable(data, columns) }),
          warn: (...args) => post({ type: "stderr", data: formatArgs(args) }),
          error: (...args) => post({ type: "stderr", data: formatArgs(args) }),
        };

        const runme = {
          clear: (target) => hostCall("runme.clear", [target]),
          clearOutputs: (target) => hostCall("runme.clearOutputs", [target]),
          runAll: (target) => hostCall("runme.runAll", [target]),
          rerun: (target) => hostCall("runme.rerun", [target]),
          getCurrentNotebook: () => hostCall("runme.getCurrentNotebook", []),
          help: () => hostCall("runme.help", []),
        };

        ${opfsHelper}

        ${netHelper}

        const createSandboxNotebooksApiClient = (callHost) => ({
          help: (topic) => callHost("notebooks.help", [topic]),
          list: (query) => callHost("notebooks.list", [query]),
          get: (target) => callHost("notebooks.get", [target]),
          update: (args) => callHost("notebooks.update", [args]),
          delete: (target) => callHost("notebooks.delete", [target]),
          execute: (args) => callHost("notebooks.execute", [args]),
          createLocal: (name, options) => callHost("notebooks.createLocal", [name, options]),
          appendCell: (args) => callHost("notebooks.appendCell", [args]),
          resolve: (reference) => callHost("notebooks.resolve", [reference]),
          show: (reference) => callHost("notebooks.show", [reference]),
          shareUrl: (reference) => callHost("notebooks.shareUrl", [reference]),
          markdownLink: (reference) => callHost("notebooks.markdownLink", [reference]),
          link: (reference) => callHost("notebooks.link", [reference]),
        });

        const notebooks = createSandboxNotebooksApiClient(hostCall);
        const documents = {
          get: (uri) => hostCall("documents.get", [uri]),
          update: (uri, content, options) => hostCall("documents.update", [uri, content, options]),
          help: () => {
            consoleProxy.log("documents.get(uri)");
            consoleProxy.log("documents.update(uri, content, { mimeType?, expectedVersion?, flush? })");
          },
        };
        const notebookDiff = {
          listDriveRevisions: (target) => hostCall("notebookDiff.listDriveRevisions", [target]),
          diffDriveRevision: (args) => hostCall("notebookDiff.diffDriveRevision", [args]),
          openDiffTab: (diff) => hostCall("notebookDiff.openDiffTab", [diff]),
          openConflictDiff: (args) => hostCall("notebookDiff.openConflictDiff", [args]),
          listConflictCells: (args) => hostCall("notebookDiff.listConflictCells", [args]),
          restoreDeletedCell: (args) => hostCall("notebookDiff.restoreDeletedCell", [args]),
          restoreAllDeletedCells: (args) => hostCall("notebookDiff.restoreAllDeletedCells", [args]),
          help: () => hostCall("notebookDiff.help", []),
        };
        const app = {
          getSessionId: () => hostCall("app.getSessionId", []),
          getSessionID: () => hostCall("app.getSessionID", []),
          startGoogleDriveOAuth: (options) => hostCall("app.startGoogleDriveOAuth", [options]),
        };
        const explorer = {
          mountDrive: (driveUrl) => hostCall("explorer.mountDrive", [driveUrl]),
          removeFolder: (uri) => hostCall("explorer.removeFolder", [uri]),
          editName: (uri) => hostCall("explorer.editName", [uri]),
          renameFolder: (uri, name) => hostCall("explorer.renameFolder", [uri, name]),
          listFolders: () => hostCall("explorer.listFolders", []),
          help: () => {
            consoleProxy.log("explorer.mountDrive(driveUrl)");
            consoleProxy.log("explorer.removeFolder(uri)");
            consoleProxy.log("explorer.editName(uri)");
            consoleProxy.log("explorer.renameFolder(uri, name)");
            consoleProxy.log("explorer.listFolders()");
          },
        };
        const credentials = {
          google: {
            setServiceAccountFromFilePath: (path) =>
              hostCall("credentials.google.setServiceAccountFromFilePath", [path]),
          },
        };
        const drive = {
          authorize: (options) => hostCall("drive.authorize", [options]),
          refreshAuth: (options) => hostCall("drive.refreshAuth", [options]),
          list: (folder) => hostCall("drive.list", [folder]),
          search: (request) => hostCall("drive.search", [request]),
          create: (folder, name) => hostCall("drive.create", [folder, name]),
          update: (idOrUri, bytes) => hostCall("drive.update", [idOrUri, bytes]),
          saveAsCurrentNotebook: (folder, name) =>
            hostCall("drive.saveAsCurrentNotebook", [folder, name]),
          help: () => {
            consoleProxy.log("drive.authorize({ mode?, prompt? })");
            consoleProxy.log("drive.refreshAuth({ mode?, prompt? })");
            consoleProxy.log("drive.list(folderIdOrUri)");
            consoleProxy.log("drive.search(filesListRequest)");
            consoleProxy.log("drive.create(folderIdOrUri, name)");
            consoleProxy.log("drive.update(fileIdOrUri, bytes)");
            consoleProxy.log("drive.saveAsCurrentNotebook(folderIdOrUri, name)");
          },
        };

        const help = () => {
          consoleProxy.log("Sandbox JS helpers:");
          consoleProxy.log("- runme.clear([target])");
          consoleProxy.log("- runme.clearOutputs([target])");
          consoleProxy.log("- runme.runAll([target])");
          consoleProxy.log("- runme.rerun([target])");
          consoleProxy.log("- runme.getCurrentNotebook()");
          consoleProxy.log("- runme.help()");
          ${opfsHelpLines}
          ${netHelpLines}
          consoleProxy.log("- notebooks.help([topic])");
          consoleProxy.log("- notebooks.list([query])");
          consoleProxy.log("- notebooks.get([target]) # omitted target = current UI notebook");
          consoleProxy.log("- notebooks.update({ target, expectedRevision?, operations })");
          consoleProxy.log("- notebooks.execute({ target, refIds })");
          consoleProxy.log("- notebooks.createLocal(name, options?)");
          consoleProxy.log("- notebooks.appendCell({ target?, at?, kind, languageId?, value?, metadata?, execute?, reason? })");
          consoleProxy.log("- notebooks.resolve([reference])");
          consoleProxy.log("- notebooks.show([reference])");
          consoleProxy.log("- notebooks.shareUrl([reference])");
          consoleProxy.log("- notebooks.markdownLink([reference])");
          consoleProxy.log("- documents.get(uri)");
          consoleProxy.log("- documents.update(uri, content, { mimeType?, expectedVersion?, flush? })");
          consoleProxy.log("- notebookDiff.listDriveRevisions([target])");
          consoleProxy.log("- notebookDiff.diffDriveRevision({ target?, revisionId, includeOutputs?, includeMetadata? })");
          consoleProxy.log("- notebookDiff.openDiffTab(diff)");
          consoleProxy.log("- notebookDiff.openConflictDiff({ target?, localUri? })");
          consoleProxy.log("- notebookDiff.listConflictCells({ target?, localUri? })");
          consoleProxy.log("- notebookDiff.restoreDeletedCell({ target?, localUri?, refId?, rowId? })");
          consoleProxy.log("- notebookDiff.restoreAllDeletedCells({ target?, localUri? })");
          consoleProxy.log("- await app.getSessionId()");
          consoleProxy.log("- await app.getSessionID()");
          consoleProxy.log("- await app.startGoogleDriveOAuth({ mode?, prompt? })");
          consoleProxy.log("- await explorer.mountDrive(driveUrl)");
          consoleProxy.log("- await explorer.editName(uri)");
          consoleProxy.log("- await explorer.renameFolder(uri, name)");
          consoleProxy.log("- await explorer.listFolders()");
          consoleProxy.log("- await credentials.google.setServiceAccountFromFilePath(path)");
          consoleProxy.log("- await drive.authorize({ mode?, prompt? })");
          consoleProxy.log("- await drive.saveAsCurrentNotebook(folderIdOrUri, fileName)");
          consoleProxy.log("- help()");
        };

        const run = async (code) => {
          let exitCode = 0;
          try {
            const runner = new Function(
              "console",
              "runme",
              "opfs",
              "net",
              "notebooks",
              "documents",
              "notebookDiff",
              "app",
              "explorer",
              "credentials",
              "drive",
              "help",
              '"use strict"; return (async () => {\\n' + code + '\\n})();',
            );
            await runner(consoleProxy, runme, opfs, net, notebooks, documents, notebookDiff, app, explorer, credentials, drive, help);
          } catch (error) {
            exitCode = 1;
            post({ type: "stderr", data: String(error) + "\\n" });
          } finally {
            post({ type: "exit", exitCode });
          }
        };

        window.addEventListener(
          "message",
          (event) => {
            const data = event.data ?? {};
            if (data.type !== "${SANDBOX_INIT_MESSAGE}") {
              return;
            }
            const transferred = event.ports?.[0];
            if (!transferred) {
              return;
            }
            port = transferred;
            port.onmessage = (innerEvent) => {
              const payload = innerEvent.data ?? {};
              if (payload.type === "run") {
                void run(String(payload.code ?? ""));
                return;
              }
              const callId = Number(payload.callId ?? 0);
              if (!callId || !pending.has(callId)) {
                return;
              }
              const callbacks = pending.get(callId);
              pending.delete(callId);
              if (payload.type === "host-result") {
                callbacks.resolve(payload.result);
                return;
              }
              if (payload.type === "host-error") {
                callbacks.reject(createHostError(payload.error));
              }
            };
            if (typeof port.start === "function") {
              port.start();
            }
            post({ type: "ready" });
          },
          { once: true },
        );
      })();
    </script>
  </body>
</html>`
}

/**
 * SandboxJSKernel executes JavaScript in a sandboxed iframe and only exposes a
 * small RPC bridge back to the host. Code running here cannot access the main
 * window realm directly.
 */
export class SandboxJSKernel {
  private readonly hooks: Required<KernelHooks>
  private readonly bridge: SandboxBridge
  private readonly allowedMethods: Set<string>
  private runCounter = 0
  private activeRunId: number | null = null

  constructor({
    bridge,
    hooks = {},
    allowedMethods = DEFAULT_SANDBOX_ALLOWED_METHODS,
  }: {
    bridge: SandboxBridge
    hooks?: KernelHooks
    allowedMethods?: string[]
  }) {
    this.bridge = bridge
    this.allowedMethods = new Set(allowedMethods)
    this.hooks = {
      onStdout: hooks.onStdout ?? (() => {}),
      onStderr: hooks.onStderr ?? (() => {}),
      onExit: hooks.onExit ?? (() => {}),
    }
  }

  async run(code: string, options: RunOptions = {}): Promise<void> {
    const runId = ++this.runCounter
    this.activeRunId = runId
    let exitCode = 0
    let session: SandboxSession | null = null
    let disposed = false

    const disposeSession = () => {
      if (disposed || !session) {
        return
      }
      disposed = true
      session.dispose()
    }

    const stdout = (data: string) => {
      if (this.activeRunId !== runId) {
        return
      }
      this.hooks.onStdout(data)
    }
    const stderr = (data: string) => {
      if (this.activeRunId !== runId) {
        return
      }
      this.hooks.onStderr(data)
    }

    try {
      if (options.signal?.aborted) {
        throw new Error('Sandbox JS execution cancelled.')
      }
      session = await this.createSession()
      if (options.signal?.aborted) {
        throw new Error('Sandbox JS execution cancelled.')
      }
      const activeSession = session
      await new Promise<void>((resolve, reject) => {
        const abortRun = () => {
          exitCode = 1
          if (this.activeRunId === runId) {
            this.activeRunId = null
          }
          disposeSession()
          reject(new Error('Sandbox JS execution cancelled.'))
        }
        options.signal?.addEventListener('abort', abortRun, { once: true })
        activeSession.port.onmessage = (
          event: MessageEvent<SandboxMessage>
        ) => {
          const payload = event.data
          if (!payload || typeof payload !== 'object') {
            return
          }
          switch (payload.type) {
            case 'stdout':
              stdout(String(payload.data ?? ''))
              break
            case 'stderr':
              stderr(String(payload.data ?? ''))
              break
            case 'host-call':
              void this.handleHostCall(activeSession.port, payload, runId)
              break
            case 'exit':
              exitCode = Number(payload.exitCode ?? 1)
              options.signal?.removeEventListener('abort', abortRun)
              resolve()
              break
            default:
              break
          }
        }
        activeSession.port.postMessage({ type: 'run', code })
      })
      disposeSession()
    } catch (error) {
      exitCode = 1
      appLogger.error('SandboxJSKernel execution failed', {
        attrs: {
          scope: 'appkernel.sandbox',
          error: String(error),
          runId,
          codeLength: code.length,
        },
      })
      stderr(`${String(error)}\n`)
    } finally {
      if (this.activeRunId === runId) {
        this.activeRunId = null
      }
      disposeSession()
      this.hooks.onExit(exitCode)
    }
  }

  private async handleHostCall(
    port: MessagePort,
    payload: Extract<SandboxMessage, { type: 'host-call' }>,
    runId: number
  ): Promise<void> {
    const callId = Number(payload.callId ?? 0)
    const method = String(payload.method ?? '')
    const args = Array.isArray(payload.args) ? payload.args : []

    if (!callId) {
      return
    }
    if (this.activeRunId !== runId) {
      port.postMessage({
        type: 'host-error',
        callId,
        error: 'Sandbox call ignored because the run is no longer active.',
      })
      return
    }
    if (!this.allowedMethods.has(method)) {
      port.postMessage({
        type: 'host-error',
        callId,
        error: `Sandbox method not allowed: ${method}`,
      })
      return
    }

    try {
      const result = await this.bridge.call(method, args)
      port.postMessage({ type: 'host-result', callId, result })
    } catch (error) {
      port.postMessage({
        type: 'host-error',
        callId,
        error: serializeHostError(error),
      })
    }
  }

  protected async createSession(): Promise<SandboxSession> {
    if (!document?.body) {
      throw new Error('SandboxJSKernel requires document.body.')
    }

    const iframe = document.createElement('iframe')
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.display = 'none'
    iframe.srcdoc = buildSandboxSrcDoc({
      enableOpfs: LOW_LEVEL_SANDBOX_ALLOWED_METHODS.some((method) =>
        this.allowedMethods.has(method)
      ),
      enableNet: this.allowedMethods.has('net.get'),
    })

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Timed out waiting for sandbox iframe to load.'))
      }, LOAD_TIMEOUT_MS)
      iframe.onload = () => {
        clearTimeout(timeoutId)
        resolve()
      }
      iframe.onerror = () => {
        clearTimeout(timeoutId)
        reject(new Error('Failed to load sandbox iframe.'))
      }
      document.body.appendChild(iframe)
    })

    if (!iframe.contentWindow) {
      iframe.remove()
      throw new Error('Sandbox iframe content window is unavailable.')
    }

    const channel = new MessageChannel()
    const hostPort = channel.port1
    hostPort.start()

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Timed out waiting for sandbox iframe readiness.'))
      }, READY_TIMEOUT_MS)

      const onReady = (event: MessageEvent<SandboxMessage>) => {
        const payload = event.data
        if (!payload || payload.type !== 'ready') {
          return
        }
        clearTimeout(timeoutId)
        hostPort.removeEventListener('message', onReady as EventListener)
        resolve()
      }
      hostPort.addEventListener('message', onReady as EventListener)
      const contentWindow = iframe.contentWindow
      if (!contentWindow) {
        reject(new Error('Sandbox iframe content window is unavailable.'))
        return
      }
      contentWindow.postMessage({ type: SANDBOX_INIT_MESSAGE }, '*', [
        channel.port2,
      ])
    })

    return {
      iframe,
      port: hostPort,
      dispose: () => {
        hostPort.onmessage = null
        try {
          hostPort.close()
        } catch {
          // no-op
        }
        iframe.remove()
      },
    }
  }
}
