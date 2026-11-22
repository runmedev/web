/**
 * CUJ: docs-dev/CUJs/suggestion-grader.md.
 * Run with Node 24. Set CUJ_PLAYWRIGHT_MODULE to an installed playwright-core
 * module and CUJ_BROWSER_EXECUTABLE when using a system Chromium browser.
 * This isolated test host implements WebMCP registration, not notebook storage
 * or a fake backend. Every document mutation calls the app's real ExecuteCode.
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(
  process.env.CUJ_PLAYWRIGHT_MODULE ||
    '../../../packages/desktop/node_modules/playwright-core'
)
const output = join(
  dirname(fileURLToPath(import.meta.url)),
  'test-output',
  `decisions-grader`
)
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CUJ_BROWSER_EXECUTABLE
    ? { executablePath: process.env.CUJ_BROWSER_EXECUTABLE }
    : {}),
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
})
await context.addInitScript(() => {
  const registered = new Map()
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: {
      registerTool(tool, options) {
        registered.set(tool.name, tool)
        options?.signal?.addEventListener(
          'abort',
          () => {
            if (registered.get(tool.name) === tool) registered.delete(tool.name)
          },
          { once: true }
        )
      },
    },
  })
  Object.defineProperty(window, '__reviewCujTools', { value: registered })
})
const page = await context.newPage()
page.setDefaultTimeout(15_000)
let sequence = 0
/** Execute only registered public tools and fail if the sandbox does not finish. */
async function code(source: string) {
  console.log(`WebMCP step ${sequence + 1}`)
  await page.waitForFunction(() => window.__reviewCujTools?.has('ExecuteCode'))
  const response = await page.evaluate(
    async ({ source, key }) => {
      const raw = await window.__reviewCujTools
        .get('ExecuteCode')
        .execute({ code: source, idempotencyKey: key, timeoutMs: 15000 }, {})
      return JSON.parse(raw)
    },
    { source, key: `review-cuj-${++sequence}` }
  )
  assert.equal(response.status, 'succeeded', JSON.stringify(response))
  const stdout = response.output.events
    .filter((e) => e.stream === 'stdout')
    .map((e) => e.text)
    .join('')
  return stdout.trim() ? JSON.parse(stdout.trim()) : null
}
/** Read or mutate through a named public AppKernel API with structured input. */
const api = (method: string, input: unknown) =>
  code('console.log(await ' + method + '(' + JSON.stringify(input) + '));')
try {
  const bodies: any[] = []
  await page.route('https://api.openai.com/v1/decisions', async (route) => {
    assert.equal(
      route.request().headers().authorization,
      'Bearer synthetic-vault-key'
    )
    const body = route.request().postDataJSON()

    bodies.push(body)
    const choice =
      body.questions[0].instructions.includes('Reject abbreviations') ||
      JSON.parse(body.input).text === 'six attempts'
        ? 'reject'
        : 'accept'
    await route.fulfill({
      json: {
        model: body.model,
        answers: [{ name: 'review', type: 'choice', choice }],
      },
    })
  })
  await page.goto(process.env.CUJ_FRONTEND_URL || 'http://localhost:5173/')
  const nb = await api('notebooks.createLocal', 'editorial-rules.runme')
  const target = { uri: nb.handle.uri }
  await api('notebooks.update', {
    target,
    operations: [
      {
        op: 'insert',
        at: { index: 0 },
        cells: [{ kind: 'markup', value: 'Accept abbreviations.' }],
      },
    ],
  })
  await page.getByLabel('Toggle Key Vault panel').click()
  await page
    .getByLabel('Vault passphrase', { exact: true })
    .fill('synthetic-passphrase')
  await page
    .getByLabel('Confirm passphrase', { exact: true })
    .fill('synthetic-passphrase')
  await page.getByRole('button', { name: 'Create vault', exact: true }).click()
  await page.getByLabel('Key name', { exact: true }).fill('review-key')
  await page
    .getByLabel('Key value', { exact: true })
    .fill('synthetic-vault-key')
  await page.getByRole('button', { name: 'Save key', exact: true }).click()
  await page.getByText('review-key', { exact: true }).first().waitFor()
  await page.getByLabel('Toggle AI grader settings panel').click()
  await page.getByLabel('OpenAI key in Key Vault').selectOption('review-key')
  await page.getByLabel('Instructions notebook').selectOption(target.uri)
  await page.getByLabel('Enable automatic predictions when reviewing').check()
  await page.getByRole('button', { name: 'Save grader settings' }).click()
  await page.getByText('AI grader settings saved.').waitFor()
  assert.equal(bodies.length, 0)
  await page
    .locator('section')
    .filter({
      has: page.getByRole('heading', { name: 'AI grader', exact: true }),
    })
    .last()
    .screenshot({ path: join(output, 'settings.png') })
  assert.equal(
    (await api('suggestionGrader.gradePhrase', { text: 'e.g.' })).accepted,
    true
  )
  const current = await api('notebooks.get', target)

  await api('notebooks.update', {
    target,
    operations: [
      {
        op: 'update',
        refId: current.notebook.cells[0].refId,
        patch: { value: 'Reject abbreviations.' },
      },
    ],
  })
  assert.equal(
    (await api('suggestionGrader.gradePhrase', { text: 'e.g.' })).accepted,
    false
  )
  assert.equal(bodies.length, 2)
  const draft = await api('notebooks.createLocal', 'draft.runme')
  const draftTarget = { uri: draft.handle.uri }
  const baseline = await api('notebooks.update', {
    target: draftTarget,
    operations: [
      {
        op: 'insert',
        at: { index: 0 },
        cells: [{ kind: 'markup', value: '5 attempts' }],
      },
    ],
  })
  await api('notebooks.update', {
    target,
    operations: [
      {
        op: 'update',
        refId: current.notebook.cells[0].refId,
        patch: { value: 'Preserve numeric limits.' },
      },
    ],
  })
  const cell = baseline.notebook.cells[0]
  const choices = ['six attempts', 'five attempts']
  const accepted = []
  for (const text of choices) {
    const verdict = await api('suggestionGrader.gradePhrase', {
      text,
      context: cell.value,
    })
    if (verdict.accepted) accepted.push(text)
  }
  assert.deepEqual(accepted, ['five attempts'])
  assert.equal(
    (await api('notebooks.get', draftTarget)).handle.revision,
    baseline.handle.revision
  )
  const applied = await api('notebooks.update', {
    target: draftTarget,
    expectedRevision: baseline.handle.revision,
    operations: [
      { op: 'update', refId: cell.refId, patch: { value: accepted[0] } },
    ],
  })
  assert.equal(applied.notebook.cells[0].value, 'five attempts')
  console.log('Passed rubric refresh and grading candidate edits before application.')
} catch (error) {
  console.error(await page.locator('body').innerText())
  throw error
} finally {
  await browser.close()
}
