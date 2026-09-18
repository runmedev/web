/** CUJ: unavailable runner diagnostics and recovery through real WebMCP tools. */
import { type ChildProcess, spawn } from 'node:child_process'
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BrowserContext, type Page, chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const directory = here.endsWith('/.generated') ? dirname(here) : here
const output = join(directory, 'test-output')
const temporary = mkdtempSync(join(tmpdir(), 'runme-unavailable-'))
const frontend = process.env.CUJ_FRONTEND_URL || 'http://localhost:5173'
mkdirSync(output, { recursive: true })
let context: BrowserContext | undefined
let runner: ChildProcess | undefined
let passed = 0
let failed = 0
const runnerLog = createWriteStream(
  join(output, 'scenario-runner-unavailable-runner.log')
)

/** Find a free loopback port; no backend is listening during the failure phase. */
async function unusedPort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', resolve)
  })
  const port = (socket.address() as { port: number }).port
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve()))
  )
  return port
}

function check(message: string, valid: boolean) {
  if (!valid) throw new Error(message)
  passed++
  console.log(`[PASS] ${message}`)
}

/** Call the actual registered WebMCP handler, preserving its sandbox boundary. */
async function tool(
  page: Page,
  name: string,
  input: Record<string, unknown>
): Promise<any> {
  const result = await page.evaluate(
    async ({ name, input }) => {
      return (window as any).__cujWebMcp[name].execute(input, {})
    },
    { name, input }
  )
  return typeof result === 'string' ? JSON.parse(result) : result
}

async function code(page: Page, source: string): Promise<any> {
  const result = await tool(page, 'ExecuteCode', { code: source })
  if (result.status !== 'succeeded') throw new Error(JSON.stringify(result))
  const stdout = result.output.events
    .filter((event: any) => event.stream === 'stdout')
    .map((event: any) => event.text)
    .join('')
  return JSON.parse(stdout.trim())
}

try {
  const browser = await chromium.launch({
    executablePath: process.env.CUJ_CHROMIUM_PATH,
    args: ['--no-sandbox'],
  })
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    recordVideo: { dir: output },
  })
  // Chromium in CI does not provide a WebMCP host. Supply only registration;
  // notebook creation, mutation, execution and reads use production tool handlers.
  await context.addInitScript(() => {
    const tools: Record<string, any> = {}
    ;(window as any).__cujWebMcp = tools
    Object.defineProperty(document, 'modelContext', {
      value: {
        registerTool(tool: any, options?: { signal?: AbortSignal }) {
          tools[tool.name] = tool
          options?.signal?.addEventListener('abort', () => {
            if (tools[tool.name] === tool) delete tools[tool.name]
          })
        },
      },
    })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  await page.goto(frontend + '/?session=runner-unavailable-cuj')
  await page.waitForFunction(() =>
    Boolean((window as any).__cujWebMcp?.ExecuteCode)
  )
  const port = await unusedPort()
  const commands =
    "printf 'runner-recovered\\n'\nread answer\nprintf 'received:%s\\n' \"$answer\""
  const created = await code(
    page,
    `
    await runmeRunners.update('unavailable-cuj', 'ws://127.0.0.1:${port}/ws');
    const doc = await notebooks.createLocal('runner-unavailable-cuj.runme');
    const uri = doc.handle.uri;
    const added = await notebooks.appendCell({target:{uri},kind:'code',languageId:'bash',value:${JSON.stringify(commands)},metadata:{'runme.dev/runnerName':'unavailable-cuj'}});
    await notebooks.show(uri);
    console.log(JSON.stringify({uri,refId:added.cell.refId}));
  `
  )
  const execution = await tool(page, 'ExecuteCode', {
    code: `console.log(await notebooks.execute({target:{uri:${JSON.stringify(created.uri)}},refIds:[${JSON.stringify(created.refId)}]}));`,
    timeoutMs: 1000,
  })
  check(
    'Missing-runner execution remains pending without inventing an exit result',
    execution.status === 'running'
  )
  const alert = page.getByTestId('cell-runner-unavailable')
  await alert.waitFor({ state: 'visible' })
  check(
    'Affected cell shows actionable unavailable-runner error',
    (await alert.textContent())!.includes('Check that it is running')
  )
  check(
    'Disconnected cell does not offer stdin',
    (await page.getByTestId('cell-stdin-form').count()) === 0
  )
  const pending = await code(
    page,
    `const d=await notebooks.get({uri:${JSON.stringify(created.uri)}}); console.log(JSON.stringify(d.notebook.cells[0]));`
  )
  check(
    'Transport failure does not persist a fake exit code',
    pending.metadata['runme.dev/exitCode'] === undefined
  )
  await page.screenshot({
    path: join(output, 'scenario-runner-unavailable-error.png'),
  })

  const config = join(temporary, 'agent.yaml')
  writeFileSync(
    config,
    `apiVersion: ""\nkind: ""\nlogging:\n  level: info\n  sinks:\n    - path: stderr\nassistantServer:\n  bindAddress: 127.0.0.1\n  port: ${port}\n  agentService: false\n  parserService: true\n  runnerService: true\n  corsOrigins:\n    - ${new URL(frontend).origin}\n`
  )
  runner = spawn(
    process.env.CUJ_RUNME_AGENT_BIN || 'runme',
    ['agent', '--config', config, 'serve'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let runnerError: Error | undefined
  runner.on('error', (error) => {
    runnerError = error
  })
  runner.stdout?.pipe(runnerLog)
  runner.stderr?.pipe(runnerLog)
  await page
    .getByTestId('cell-stdin-form')
    .waitFor({ state: 'visible', timeout: 30000 })
  if (runnerError) throw runnerError
  check(
    'Starting the real runner clears the error without rerunning the cell',
    (await alert.count()) === 0
  )
  await page.getByTestId('cell-stdin-input').fill('ok')
  await page.getByTestId('cell-stdin-submit').click()
  // A long poll can return on new output before execution has finished. Keep
  // advancing its cursor until completion rather than mistaking output for done.
  let finished = execution
  const deadline = Date.now() + 30_000
  while (finished.status === 'running' && Date.now() < deadline) {
    finished = await tool(page, 'GetExecuteCodeOperation', {
      operationId: execution.operationId,
      afterSequence: finished.output?.nextSequence ?? 0,
      waitMs: 5_000,
    })
  }

  check(
    'Queued execution finishes after recovery and stdin',
    finished.status === 'succeeded'
  )
  const completed = await code(
    page,
    `const d=await notebooks.get({uri:${JSON.stringify(created.uri)}}); console.log(JSON.stringify({metadata:d.notebook.cells[0].metadata, output:d.notebook.cells[0].outputs.map(o=>o.items.map(i=>new TextDecoder().decode(i.data)).join('')).join('')}));`
  )
  check(
    'The same execution resumes and reports the runner exit code',
    completed.metadata['runme.dev/lastRunID'] ===
      pending.metadata['runme.dev/lastRunID'] &&
      completed.metadata['runme.dev/exitCode'] === '0'
  )
  check(
    'Output contains real command output and submitted stdin',
    completed.output.includes('runner-recovered') &&
      completed.output.includes('received:ok')
  )
  check(
    'Transient unavailable diagnostic is absent from saved outputs',
    !completed.output.includes('Runner unavailable')
  )
  await page.screenshot({
    path: join(output, 'scenario-runner-unavailable-recovered.png'),
  })
  const video = await page.video()?.path()
  await context.close()
  context = undefined
  await browser.close()
  if (video) renameSync(video, join(output, 'scenario-runner-unavailable.webm'))
} catch (error) {
  failed++
  console.error(
    `[FAIL] ${error instanceof Error ? error.message : String(error)}`
  )
  if (context?.pages()[0])
    await context
      .pages()[0]
      .screenshot({
        path: join(output, 'scenario-runner-unavailable-failure.png'),
      })
      .catch(() => {})
} finally {
  const browser = context?.browser()
  await context?.close()
  await browser?.close()
  if (runner && runner.exitCode === null && !runner.killed) {
    runner.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        runner?.kill('SIGKILL')
        resolve()
      }, 5000)
      runner!.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
  runnerLog.end()
  rmSync(temporary, { recursive: true, force: true })
  console.log(
    `Assertions: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`
  )
  if (failed) process.exitCode = 1
}
