import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ElectronApplication,
  _electron as electron,
} from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.resolve(
  root,
  '../../app/test/browser/test-output/desktop'
)
await mkdir(artifacts, { recursive: true })
const profile = await mkdtemp(path.join(os.tmpdir(), 'runme-desktop-smoke-'))
let application: ElectronApplication | undefined
let client: Client | undefined
const diagnostics: string[] = []

/** Exercise real Electron + real MCP + real IndexedDB, without fake backend services. */
async function launch(uiPort = '0') {
  application = await electron.launch({
    ...(process.env.RUNME_DESKTOP_EXECUTABLE
      ? { executablePath: process.env.RUNME_DESKTOP_EXECUTABLE, args: [] }
      : { args: [root] }),
    env: {
      ...process.env,
      RUNME_DESKTOP_DATA_DIR: profile,
      RUNME_UI_PORT: uiPort,
      RUNME_MCP_PORT: '0',
      RUNME_DESKTOP_HIDDEN: '1',
      RUNME_RUNNER_CONFIG: '',
    },
    timeout: 60_000,
  })
  application
    .process()
    .stderr?.on('data', (chunk) => diagnostics.push(String(chunk)))
  const page = await application.firstWindow()
  page.on('pageerror', (error) =>
    diagnostics.push(error.stack ?? error.message)
  )
  // loadURL finishes before connection metadata is written; wait on observable readiness.
  let connection: { url: string; origin: string; tokenFile: string } | undefined
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      connection = JSON.parse(
        await readFile(path.join(profile, 'connection.json'), 'utf8')
      )
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  assert(connection, 'Electron did not publish connection metadata')
  const token = await readFile(connection.tokenFile, 'utf8')
  client = new Client({ name: 'runme-desktop-smoke', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  )
  let tools: string[] = []
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      tools = (await client.listTools()).tools.map((tool) => tool.name)
      if (tools.includes('ExecuteCode')) break
    } catch {
      /* AppKernel hydration can finish after the HTML has loaded. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(
    tools.includes('ExecuteCode'),
    `Missing app tools: ${tools.join(', ')}`
  )
  assert.equal(
    await page.evaluate(() => typeof (window as any).require),
    'undefined'
  )
  assert.equal(await page.evaluate(() => isSecureContext), true)
  assert.equal((await fetch(connection.url, { method: 'POST' })).status, 403)
  return { page, connection, tools }
}

/** Execute through the public MCP protocol and poll the same app operation registry as WebMCP. */
async function execute(code: string) {
  assert(client)
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client!.callTool({ name, arguments: args })
    assert(!result.isError, JSON.stringify(result))
    return JSON.parse((result.content as Array<{ text: string }>)[0].text)
  }
  let operation = await call('ExecuteCode', { code, timeoutMs: 1000 })
  for (
    let attempt = 0;
    ['running', 'queued'].includes(operation.status) && attempt < 20;
    attempt++
  ) {
    operation = await call('GetExecuteCodeOperation', {
      operationId: operation.operationId,
      waitMs: 1000,
    })
  }
  assert.equal(operation.status, 'succeeded', JSON.stringify(operation))
  return operation.output.events
    .map((event: { text: string }) => event.text)
    .join('')
}

try {
  const initial = await launch()
  let { page } = initial
  const { connection, tools } = initial
  assert.match(await execute('console.log(6 * 7)'), /42/)
  const output = await execute(`
    const created = await notebooks.createLocal('Desktop MCP smoke.runme');
    await notebooks.appendCell({ target: { handle: created.handle }, kind: 'markup', value: '# Created through MCP' });
    const doc = await notebooks.get({ uri: created.handle.uri });
    await notebooks.show(created.handle.uri);
    console.log(JSON.stringify({ uri: created.handle.uri, cells: doc.notebook.cells.map(c => c.value) }));
  `)
  assert.match(output, /Created through MCP/)
  const saved = JSON.parse(output.trim())
  await page.getByText('Created through MCP', { exact: true }).first().waitFor()
  await page.screenshot({
    path: path.join(artifacts, 'notebook.png'),
    fullPage: true,
  })
  await client!.close()
  await application!.close()
  await rm(path.join(profile, 'connection.json'))
  const restart = await launch(new URL(connection.origin).port)
  page = restart.page
  assert.match(
    await execute(
      `await notebooks.open(${JSON.stringify(saved.uri)}); const doc = await notebooks.get({ uri: ${JSON.stringify(saved.uri)} }); console.log(JSON.stringify(doc.notebook.cells.map(c => c.value)));`
    ),
    /Created through MCP/
  )
  await page.reload()
  // Registration after reload is asynchronous; use observable tool discovery.
  await page.waitForFunction(() => !!(window as any).runmeDesktop)
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (
        (await client!.listTools()).tools.some((t) => t.name === 'ExecuteCode')
      )
        break
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.match(await execute('console.log(21 * 2)'), /42/)
  await writeFile(
    path.join(artifacts, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        tools,
        persistence: 'verified after process restart',
        reload: 'verified',
        transport: 'Streamable HTTP',
        nativeWebMcpRequired: false,
      },
      null,
      2
    )
  )
  process.stdout.write(
    'PASS: real Electron MCP discovery, execution, notebook creation, UI visibility, process-restart persistence, reload, and authentication.\n'
  )
} finally {
  await writeFile(
    path.join(artifacts, 'diagnostics.log'),
    diagnostics.join('\n')
  )
  await client?.close().catch(() => {})
  await application?.close().catch(() => {})
  await rm(profile, { recursive: true, force: true })
}
