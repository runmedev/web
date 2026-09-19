/** CUJ: durable session restore after the host recreates a browser tab. */
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BrowserContext, type Page, chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const directory = here.endsWith('/.generated') ? dirname(here) : here
const output = join(directory, 'test-output')
const profile = mkdtempSync(join(tmpdir(), 'runme-session-cuj-'))
const frontend = process.env.CUJ_FRONTEND_URL || 'http://localhost:5173'
const prefix = 'runme/notebook-session/v1/'
mkdirSync(output, { recursive: true })
let context: BrowserContext | undefined
let passed = 0
let failed = 0

function check(message: string, valid: boolean) {
  if (!valid) throw new Error(message)
  passed++
  console.log(`[PASS] ${message}`)
}

async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.CUJ_CHROMIUM_PATH,
    args: ['--no-sandbox'],
    viewport: { width: 1280, height: 900 },
    recordVideo: { dir: output, size: { width: 1280, height: 900 } },
  })
  return context.pages()[0] || (await context.newPage())
}

async function ready(page: Page, url: string) {
  page.setDefaultTimeout(20000)
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).app?.localNotebooks))
}

async function finish(phase: string) {
  const videos = await Promise.all(
    context!.pages().map((page) => page.video()?.path())
  )
  await context!.close()
  context = undefined
  for (const [i, video] of videos.entries()) {
    if (!video) continue
    const path = join(output, `scenario-durable-sessions-${phase}-${i}.webm`)
    renameSync(video, path)
    console.log(`Movie: ${path}`)
  }
}

try {
  let page = await launch()
  await ready(page, frontend + '/?session=restore-cuj')
  // Seed actual local .runme files and the legacy same-tab restore cache.
  // Production providers must hydrate and subsequently persist this state.
  const files = await page.evaluate(async () => {
    const db = (window as any).app.localNotebooks
    // Browser-side imports are served by Vite, not resolved by the Node driver.
    const storageModule = '/src/storage/local.ts'
    const logModule = '/src/lib/operationLog/index.ts'
    const { LOCAL_FOLDER_URI } = await import(storageModule)
    const {
      parseOperationLog,
      serializeOperationLog,
      createRunmeOperation,
      causalHeads,
    } = await import(logModule)
    if (!(await db.folders.get(LOCAL_FOLDER_URI)))
      await db.folders.put({
        id: LOCAL_FOLDER_URI,
        name: 'Local',
        remoteId: '',
        children: [],
        lastSynced: '',
      })
    const files = []
    for (const name of ['first', 'second']) {
      const file = await db.create(LOCAL_FOLDER_URI, name + '.runme')
      await (
        await db.createOperationLogSaveStore(file.uri)
      ).save(file.uri, await db.load(file.uri))
      const log = parseOperationLog(await db.loadContent(file.uri))
      log.operations.push(
        createRunmeOperation({
          actorId: 'session-cuj',
          actorSequence: 1,
          knownOperations: log.operations,
          dependencies: causalHeads(log.operations),
          kind: 'cell.create',
          payload: {
            cell_id: 'session-' + name,
            position: [[1, 'session-cuj', 1]],
            cell: {
              kind: 'markup',
              language_id: 'markdown',
              value: '# ' + name + ' survives restart',
              metadata: {},
            },
          },
        })
      )
      await db.saveContent(
        file.uri,
        serializeOperationLog(log.header, log.operations),
        'application/vnd.runme.notebook+jsonl'
      )
      files.push({ uri: file.uri, requestedUri: file.uri, name: file.name })
    }
    sessionStorage.setItem('runme/openNotebooks', JSON.stringify(files))
    sessionStorage.setItem('runme/currentDoc', files[1].uri)
    return files
  })
  await page.reload()
  await page.getByRole('heading', { name: 'second survives restart' }).waitFor()
  const resumeUrl = page.url()
  const id = new URL(resumeUrl).searchParams.get('session')!
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    prefix + id
  )
  check(
    'Legacy open order migrates to durable references',
    JSON.stringify(saved.openNotebooks) === JSON.stringify(files)
  )
  check('Selected notebook is persisted', saved.currentDoc === files[1].uri)
  await finish('before-restart')

  page = await launch()
  // New document in a new browser process: no restored tab sessionStorage.
  await page.addInitScript(() => {
    ;(window as any).__sessionWasEmpty =
      sessionStorage.getItem('runme/sessionId') === null
  })
  await ready(page, resumeUrl)
  await page.getByRole('heading', { name: 'second survives restart' }).waitFor()
  check(
    'Browser restart begins without sessionStorage',
    await page.evaluate(() => (window as any).__sessionWasEmpty)
  )
  check(
    'Saved URL retains its original session identity',
    new URL(page.url()).searchParams.get('session') === id
  )
  check(
    'Notebook order is restored',
    (await page.getByRole('tab').count()) === 2 &&
      (await page.getByRole('tab').nth(0).getAttribute('id'))!.endsWith(
        files[0].uri
      ) &&
      (await page.getByRole('tab').nth(1).getAttribute('id'))!.endsWith(
        files[1].uri
      )
  )
  check(
    'Selected notebook is restored',
    (await page
      .getByRole('tab', { name: 'second.runme', exact: true })
      .getAttribute('aria-selected')) === 'true'
  )
  await page.screenshot({
    path: join(output, 'scenario-durable-sessions-restored.png'),
  })

  const beforeCopy = await page.evaluate(
    (key) => localStorage.getItem(key),
    prefix + id
  )
  const clonedStorage = await page.evaluate(() =>
    Object.fromEntries(Object.entries(sessionStorage))
  )
  const copy = await context!.newPage()
  await copy.addInitScript((state) => {
    for (const [key, value] of Object.entries(state))
      sessionStorage.setItem(key, value)
  }, clonedStorage)
  await ready(copy, resumeUrl)
  await copy.screenshot({
    path: join(output, 'scenario-durable-sessions-copy.png'),
  })
  await copy.getByText('No open notebooks yet', { exact: true }).waitFor()
  check(
    'Duplicating the live URL and sessionStorage forks the session',
    new URL(copy.url()).searchParams.get('session') !== id
  )
  check(
    'Forked session uses readable words without a UUID',
    /^[a-z]+(?:-[a-z]+)+$/.test(
      new URL(copy.url()).searchParams.get('session') || ''
    )
  )
  check(
    'Duplicate starts without notebook tabs',
    (await copy.getByRole('tab', { name: /\.runme$/ }).count()) === 0
  )
  check(
    'Duplicate does not overwrite original restore metadata',
    (await page.evaluate((key) => localStorage.getItem(key), prefix + id)) ===
      beforeCopy
  )

  // Edit through Monaco and verify the existing autosave path still works.
  await page.locator('#markdown-rendered-session-second').dblclick()
  const editor = page
    .locator('#markdown-action-session-second textarea')
    .first()
  await editor.waitFor({ state: 'visible' })
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText('# edited after restart')
  await page.keyboard.press('Escape')
  await page.getByRole('heading', { name: 'edited after restart' }).waitFor()
  // waitForFunction treats a Promise as truthy; poll the awaited disk read in
  // Node so this assertion really waits for the debounced OPFS autosave.
  for (let attempt = 0; ; attempt++) {
    const saved = await page.evaluate(async (uri) => {
      const notebook = await (window as any).app.localNotebooks.load(uri)
      return notebook.cells.some(
        (cell: any) => cell.value === '# edited after restart'
      )
    }, files[1].uri)
    if (saved) break
    if (attempt >= 100)
      throw new Error('Edited notebook did not autosave to disk')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  check('Restored notebook remains editable and autosaves', true)
  await finish('restored-and-duplicate')
  page = await launch()
  await ready(page, resumeUrl)
  await page.getByRole('heading', { name: 'edited after restart' }).waitFor()
  check('Autosaved edit survives another full browser restart', true)
  // Exercise BFCache lifecycle events explicitly: the cached page relinquishes
  // its session, another tab closes the notebooks, then the old page returns.
  // Synthetic events make this deterministic without relying on Chromium's
  // eligibility heuristics, while using the real reload and persistence paths.
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
  )
  const takeover = await context!.newPage()
  await ready(takeover, resumeUrl)
  await takeover.getByRole('heading', { name: 'edited after restart' }).waitFor()
  check(
    'Another tab can claim a session relinquished for BFCache',
    new URL(takeover.url()).searchParams.get('session') === id
  )
  // Close all notebooks, then prove empty is durable rather than resurrected.
  for (const file of [...files].reverse())
    await takeover
      .getByRole('button', { name: 'Close ' + file.name, exact: true })
      .click()
  await takeover.getByText('No open notebooks yet', { exact: true }).waitFor()
  await takeover.close()
  await Promise.all([
    page.waitForEvent('load'),
    page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    ),
  ])
  await page.getByText('No open notebooks yet', { exact: true }).waitFor()
  check(
    'BFCache return restores the newer empty session instead of stale tabs',
    new URL(page.url()).searchParams.get('session') === id &&
      (await page.getByRole('tab', { name: /\.runme$/ }).count()) === 0
  )
  await finish('edited')
  page = await launch()
  await ready(page, resumeUrl)
  await page.getByText('No open notebooks yet', { exact: true }).waitFor()
  check(
    'Closing all notebooks stays empty after restart',
    (await page.getByRole('tab', { name: /\.runme$/ }).count()) === 0
  )
  await finish('closed')
} catch (error) {
  failed++
  console.log(`[FAIL] ${String(error)}`)
  const page = context?.pages()[0]
  await page
    ?.screenshot({
      path: join(output, 'scenario-durable-sessions-failure.png'),
    })
    .catch(() => {})
} finally {
  if (context) await finish('failure')
  rmSync(profile, { recursive: true, force: true })
}
console.log(
  `Assertions: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`
)
process.exitCode = failed ? 1 : 0
