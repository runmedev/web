import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import path from 'node:path'

import { GoogleCredentials, googlePolicyFromEnv } from './googleCredentials.js'
import { channels } from './protocol.js'
import { startAssetServer, startMcpServer } from './server.js'
import { ToolBridge } from './toolBridge.js'

app.setName('Runme')
if (process.env.RUNME_DESKTOP_DATA_DIR)
  app.setPath('userData', path.resolve(process.env.RUNME_DESKTOP_DATA_DIR))
// A second process must not open the same IndexedDB/profile or compete for ports.
if (!app.requestSingleInstanceLock()) app.exit(1)

let window: BrowserWindow | undefined
let runner: ChildProcess | undefined
let bridge: ToolBridge | undefined
const servers: Server[] = []
let stopping = false
let flushing = false

/** Electron owns servers and the optional runner; no subprocess survives a normal exit. */
async function stop() {
  if (stopping) return
  stopping = true
  bridge?.reset()
  for (const server of servers) {
    server.closeAllConnections()
    server.close()
  }
  if (runner?.pid && runner.exitCode === null && runner.signalCode === null) {
    const child = runner
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
}

app.on('before-quit', (event) => {
  if (stopping) return
  event.preventDefault()
  if (flushing) return
  flushing = true
  void bridge
    ?.flush()
    .then(async () => {
      await stop()
      app.quit()
    })
    .catch((error: unknown) => {
      flushing = false
      dialog.showErrorBox(
        'Runme could not save before closing',
        `The app remains open so you can recover pending edits. ${String(error)}`
      )
    })
  if (!bridge) {
    void stop().then(() => app.quit())
  }
})
app.on('window-all-closed', () => app.quit())
app.on('second-instance', () => {
  window?.show()
  window?.focus()
})
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => app.quit())

/** Read a stable MCP token from the private profile; never expose it to renderer assets/logs. */
async function loadToken(directory: string) {
  const filename = path.join(directory, 'mcp-token')
  let token = process.env.RUNME_MCP_TOKEN
  if (!token) {
    try {
      token = (await readFile(filename, 'utf8')).trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  token ||= randomBytes(32).toString('hex')
  if (token.length < 32 || /\s/.test(token))
    throw new Error(
      'RUNME_MCP_TOKEN must contain at least 32 non-whitespace characters'
    )
  await writeFile(filename, token, { mode: 0o600 })
  await chmod(filename, 0o600)
  return token
}

/** Port zero is reserved for tests; deployments keep the UI origin stable across restarts. */
function port(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 0 || value > 65535)
    throw new Error(`Invalid ${name}`)
  return value
}

async function start() {
  await app.whenReady()
  const directory = app.getPath('userData')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const token = await loadToken(directory)
  const resources = app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, '..')
  const assets = path.join(resources, 'web')
  const googlePolicy = googlePolicyFromEnv(process.env)
  const googleCredentials = new GoogleCredentials(googlePolicy)
  const config = process.env.RUNME_APP_CONFIG
    ? await readFile(path.resolve(process.env.RUNME_APP_CONFIG), 'utf8')
    : JSON.stringify({
        agent: {
          endpoint: 'http://127.0.0.1:9988',
          defaultRunnerEndpoint: 'ws://127.0.0.1:9988/ws',
        },
        externalServices: { analytics: false, remoteContent: false },
        ...(googlePolicy
          ? {
              googleDrive: {
                authFlow: 'workload_identity',
                provider: 'gke_metadata',
                expectedServiceAccountEmail: googlePolicy.serviceAccountEmail,
                scopes: googlePolicy.allowedScopes,
              },
            }
          : {}),
      })
  const ui = await startAssetServer(
    assets,
    port('RUNME_UI_PORT', 43124),
    config
  )
  servers.push(ui)
  const origin = `http://127.0.0.1:${(ui.address() as { port: number }).port}`
  if (process.env.RUNME_RUNNER_CONFIG) {
    const executable =
      process.env.RUNME_RUNNER_BINARY ??
      path.join(
        resources,
        'runner',
        process.platform === 'win32' ? 'runme.exe' : 'runme'
      )
    await access(executable)
    runner = spawn(
      executable,
      [
        'agent',
        'serve',
        '--config',
        path.resolve(process.env.RUNME_RUNNER_CONFIG),
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    )
    runner.once('error', (error) => {
      process.stderr.write(`Runme runner failed: ${error.message}\n`)
      void stop().then(() => app.exit(1))
    })
    runner.once('exit', (code) => {
      if (!stopping) {
        process.stderr.write(`Runme runner exited (${code})\n`)
        app.quit()
      }
    })
  }
  window = new BrowserWindow({
    width: 1280,
    height: 900,
    show: process.env.RUNME_DESKTOP_HIDDEN !== '1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.on('close', (event) => {
    if (!stopping) {
      event.preventDefault()
      app.quit()
    }
  })
  const contents = window.webContents
  contents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false)
  )
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault()
  })
  bridge = new ToolBridge((request) => {
    if (!contents.isDestroyed()) contents.send(channels.request, request)
  })
  const currentBridge = bridge
  const trusted = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent
  ) =>
    event.sender === contents &&
    event.senderFrame === contents.mainFrame &&
    new URL(event.senderFrame.url).origin === origin
  ipcMain.handle(channels.googleToken, async (event, request) => {
    if (!trusted(event)) throw new Error('Untrusted Google credential caller')
    return googleCredentials.mint(request)
  })
  ipcMain.on(channels.catalog, (event, tools) => {
    if (!trusted(event)) return
    try {
      currentBridge.setTools(tools)
    } catch {
      currentBridge.reset()
    }
  })
  ipcMain.on(channels.response, (event, response) => {
    if (trusted(event) && response && typeof response.id === 'string')
      currentBridge.respond(response)
  })
  contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) currentBridge.reset()
  })
  contents.on('render-process-gone', () => {
    currentBridge.reset()
    app.quit()
  })
  const mcp = await startMcpServer(
    currentBridge,
    token,
    port('RUNME_MCP_PORT', 43123)
  )
  servers.push(mcp)
  const url = `http://127.0.0.1:${(mcp.address() as { port: number }).port}/mcp`
  await window.loadURL(origin)
  await writeFile(
    path.join(directory, 'connection.json'),
    JSON.stringify(
      {
        url,
        origin,
        tokenFile: path.join(directory, 'mcp-token'),
        pid: process.pid,
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
  process.stderr.write(
    `Runme ready. MCP: ${url}\nConnection metadata: ${path.join(directory, 'connection.json')}\n`
  )
}

void start().catch(async (error: unknown) => {
  process.stderr.write(`Runme startup failed: ${String(error)}\n`)
  await stop()
  app.exit(1)
})
