/**
 * CUJ: docs-dev/CUJs/notebook-review-rounds.md.
 * Run with Node 24. Set CUJ_PLAYWRIGHT_MODULE to an installed playwright-core
 * module and CUJ_BROWSER_EXECUTABLE when using a system Chromium browser.
 * This isolated test host implements WebMCP registration, not notebook storage
 * or a fake backend. Every document mutation calls the app's real ExecuteCode.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(
  process.env.CUJ_PLAYWRIGHT_MODULE || 'playwright-core'
)
const output = join(
  dirname(fileURLToPath(import.meta.url)),
  'test-output',
  `notebook-review-${Date.now()}`
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
  recordVideo: { dir: output, size: { width: 1440, height: 1000 } },
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
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  checks: [],
}
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
async function checkpoint(name: string) {
  await page.screenshot({ path: join(output, `${name}.png`) })
  await writeFile(
    join(output, `${name}.txt`),
    await page.locator('body').innerText()
  )
  ;(evidence.checks as string[]).push(name)
  // A short dwell makes the real interaction video legible to a reviewer.
  await page.waitForTimeout(1200)
}
/** Read or mutate through a named public AppKernel API with structured input. */
const api = (method: string, input: unknown) =>
  code('console.log(await ' + method + '(' + JSON.stringify(input) + '));')
try {
  await page.goto(process.env.CUJ_FRONTEND_URL || 'http://localhost:5173/')
  const { session } = await code(
    'console.log({session:await app.getSessionID()})'
  )
  assert.equal(new URL(page.url()).searchParams.get('session'), session)
  const created = await api('notebooks.createLocal', 'comment-first-cuj.runme')
  const uri = created.handle.uri
  const target = { uri }
  const values = [
    '# Runbook',
    '## Setup',
    'Original setup checklist',
    '### Old credentials',
    'Retired credential flow',
    '## Rollout',
    'Rollout unchanged',
  ]
  await api('notebooks.update', {
    target,
    expectedRevision: created.handle.revision,
    operations: [
      {
        op: 'insert',
        at: { index: 0 },
        cells: values.map((value) => ({
          kind: 'markup',
          languageId: 'markdown',
          value,
        })),
      },
    ],
  })
  const initial = await api('notebooks.get', target)
  const ids = initial.notebook.cells.map((c) => c.refId)
  const start = (await api('revisions.list', { target })).at(-1)
  await api('revisions.label', {
    target,
    revisionId: start.id,
    name: 'Original',
    description: 'Human commented version',
  })
  const thread = await api('comments.add', {
    target,
    cellId: ids[2],
    content: 'Please explain the setup checks.',
  })
  await api('notebooks.show', uri)
  const initialComments = await api('comments.list', { target, status: 'all' })
  assert.ok(
    initialComments.some((c) => c.id === thread.id),
    JSON.stringify({ thread, initialComments })
  )
  await page.getByRole('button', { name: 'Toggle Comments panel' }).click()
  const editorComments = page.getByRole('complementary', {
    name: 'Notebook comments',
  })
  await editorComments
    .getByText('Please explain the setup checks.', { exact: true })
    .waitFor()
  await checkpoint('01-human-comments-in-editor')
  await api('notebooks.update', {
    target,
    expectedRevision: initial.handle.revision,
    operations: [
      {
        op: 'update',
        refId: ids[2],
        patch: { value: 'Verify the new setup checklist' },
      },
      { op: 'remove', refIds: ids.slice(3, 5) },
    ],
  })
  await api('comments.reply', {
    target,
    commentId: thread.id,
    content: 'Added explicit checks; removed retired credentials.',
    author: { displayName: 'Codex', kind: 'agent' },
  })
  const end = (await api('revisions.list', { target })).at(-1)
  await api('revisions.label', {
    target,
    revisionId: end.id,
    name: 'Codex addressed comments',
  })
  const pair = { target, startRevisionId: start.id, endRevisionId: end.id }
  await page
    .getByRole('button', { name: 'Review suggestions', exact: true })
    .click()
  const comparison = page.getByRole('complementary', {
    name: 'Notebook comparison',
  })
  const canvas = page.locator('#review-round-canvas')
  await comparison.getByRole('heading', { name: 'Compare changes' }).waitFor()
  await page
    .getByLabel('Start revision', { exact: true })
    .selectOption(start.id)
  await page.getByLabel('End revision', { exact: true }).selectOption(end.id)
  await canvas
    .getByText('Please explain the setup checks.', { exact: true })
    .waitFor()
  await canvas
    .getByText('Added explicit checks; removed retired credentials.', {
      exact: true,
    })
    .waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: 'Start review', exact: true })
      .count(),
    0
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Submit review', exact: true })
      .count(),
    0
  )
  assert.equal((await api('reviews.list', { target })).length, 0)
  await checkpoint('02-commentable-diff-with-original-thread')
  await page.getByRole('checkbox', { name: 'Named revisions only' }).check()
  await canvas
    .getByText('Please explain the setup checks.', { exact: true })
    .waitFor()
  assert.equal(
    (await api('revisions.list', { target })).find((v) => v.id === start.id)
      .lastChangedAt,
    start.lastChangedAt
  )
  await checkpoint('03-named-revisions-preserve-dates')
  await page
    .getByRole('radio', { name: 'Heading / section range', exact: true })
    .check()
  await page
    .getByLabel('From heading', { exact: true })
    .selectOption(ids[1] + ':1')
  await page.waitForFunction(() => {
    const text =
      document.querySelector('#review-round-canvas')?.textContent ?? ''
    return (
      text.includes('checklist') &&
      !text.includes('Rollout unchanged') &&
      !text.includes('Retired credential flow')
    )
  })
  await checkpoint('04-setup-section-filter')
  const scoped = { ...pair, cellIds: ids.slice(1, 3) }
  const selected = await api('reviews.comment', {
    ...scoped,
    cellId: ids[2],
    side: 'head',
    sourceRange: { start: 0, end: 6, unit: 'utf-16' },
    content: 'Which verification command?',
    author: { displayName: 'Codex', kind: 'agent' },
  })
  assert.equal(JSON.parse(selected.anchor).runme.diffTarget.quote, 'Verify')
  await canvas
    .getByText('Which verification command?', { exact: true })
    .waitFor()
  const whole = await api('reviews.comment', {
    ...scoped,
    content: 'Setup is almost ready.',
  })
  await api('comments.reply', {
    target,
    commentId: whole.id,
    content: 'One more concrete example would help.',
  })
  await comparison
    .getByText('Setup is almost ready.', { exact: true })
    .waitFor()
  assert.equal(
    await comparison
      .getByText('Which verification command?', { exact: true })
      .count(),
    0
  )
  assert.equal(
    await comparison
      .getByRole('region', { name: 'Suggestion discussion' })
      .count(),
    1
  )
  await checkpoint('05-inline-source-and-suggestion-conversation')
  const assessment = await api('reviews.assess', {
    ...scoped,
    outcome: 'good_enough',
  })
  await comparison
    .getByRole('status')
    .getByText('Good Enough', { exact: true })
    .waitFor()
  await checkpoint('06-good-enough-selected-scope')
  await page.getByRole('button', { name: 'Edit view', exact: true }).click()
  await editorComments
    .getByText('Which verification command?', { exact: true })
    .waitFor()
  await editorComments
    .getByText('Setup is almost ready.', { exact: true })
    .waitFor()
  await api('comments.reply', {
    target,
    commentId: selected.id,
    content: 'Reply from the edit-view context.',
  })
  await editorComments
    .getByText('Reply from the edit-view context.', { exact: true })
    .waitFor()
  await checkpoint('07-diff-comments-and-replies-in-editor')
  await page
    .getByRole('button', { name: 'Review suggestions', exact: true })
    .click()
  await canvas
    .getByText('Reply from the edit-view context.', { exact: true })
    .waitFor()
  await page
    .getByLabel('Scope outline revision', { exact: true })
    .selectOption('base')
  await page
    .getByLabel('From heading', { exact: true })
    .selectOption(ids[3] + ':1')
  await canvas.getByText('Retired credential flow', { exact: true }).waitFor()
  const deletedScope = { ...pair, cellIds: ids.slice(3, 5) }
  const deletedComment = await api('reviews.comment', {
    ...deletedScope,
    cellId: ids[4],
    side: 'base',
    content: 'Why remove this section?',
  })
  const deletedAssessment = await api('reviews.assess', {
    ...deletedScope,
    outcome: 'needs_more_work',
  })
  assert.notEqual(deletedAssessment.comparisonId, assessment.comparisonId)
  await canvas.getByText('Why remove this section?', { exact: true }).waitFor()
  assert.equal(
    await canvas
      .getByText('Which verification command?', { exact: true })
      .count(),
    0
  )
  await checkpoint('08-deleted-section-independent-feedback')
  const duplicate = await api('reviews.assess', {
    ...deletedScope,
    cellIds: [ids[4], ids[3], ids[4]],
    outcome: 'needs_more_work',
  })
  assert.equal(duplicate.comparisonId, deletedAssessment.comparisonId)
  const snapshot = {
    records: await api('reviews.list', { target }),
    comments: await api('comments.list', { target, status: 'all' }),
    doc: await api('notebooks.get', target),
  }
  assert.equal(snapshot.records.length, 2)
  assert.equal(
    snapshot.doc.notebook.cells[2].value,
    'Verify the new setup checklist'
  )
  assert.ok(snapshot.comments.every((c) => !c.resolved))
  await page.reload()
  await comparison.getByRole('heading', { name: 'Compare changes' }).waitFor()
  assert.deepEqual(await api('reviews.list', { target }), snapshot.records)
  assert.deepEqual(
    await api('comments.list', { target, status: 'all' }),
    snapshot.comments
  )
  await checkpoint('09-reload-preserves-threads-and-feedback')
  // Another AI response changes the live document but not prior comparisons.
  const current = await api('notebooks.get', target)
  await api('notebooks.update', {
    target,
    expectedRevision: current.handle.revision,
    operations: [
      {
        op: 'update',
        refId: ids[2],
        patch: { value: 'Run the health command and confirm two replicas.' },
      },
    ],
  })
  await api('comments.reply', {
    target,
    commentId: selected.id,
    content: 'Added the concrete health command.',
    author: { displayName: 'Codex', kind: 'agent' },
  })
  const final = (await api('revisions.list', { target })).at(-1)
  await page.getByLabel('Start revision', { exact: true }).selectOption(end.id)
  await page.getByLabel('End revision', { exact: true }).selectOption(final.id)
  await canvas
    .getByText('Added the concrete health command.', { exact: true })
    .waitFor()
  await canvas
    .getByText(/Outdated context/)
    .first()
    .waitFor()
  const original = await api('reviews.preview', pair)
  assert.equal(original.after.cells[2].value, 'Verify the new setup checklist')
  await checkpoint('10-second-iteration-preserves-history')
  evidence.status = 'passed'
  evidence.uri = uri
  evidence.threadIds = [thread.id, selected.id, whole.id, deletedComment.id]
} catch (error) {
  evidence.status = 'failed'
  evidence.error = String(error)
  await checkpoint('failure')
  throw error
} finally {
  await context.close()
  evidence.video = await page.video().path()
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(evidence, null, 2)
  )
  await browser.close()
  console.log(JSON.stringify({ output, ...evidence }, null, 2))
}
