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
try {
  await page.goto(process.env.CUJ_FRONTEND_URL || 'http://localhost:5173/')
  const { session } = await code(
    'console.log({session:await app.getSessionID()})'
  )
  assert.equal(new URL(page.url()).searchParams.get('session'), session)
  const created = await code(
    'const d=await notebooks.createLocal("review-rounds-recording.runme"); console.log({uri:d.handle.uri});'
  )
  const uri = created.uri
  evidence.uri = uri
  const cells = [
    {
      kind: 'markup',
      value:
        '# Release checklist\n\nDeploy the service, then check that it works.',
      metadata: { name: 'checklist' },
    },
    {
      kind: 'code',
      languageId: 'javascript',
      value: 'console.log("Ready: two replicas healthy")',
      metadata: {
        name: 'health-check',
        'runme.dev/runnerName': 'appkernel-js-sandbox',
      },
    },
  ]
  const seeded = await code(
    `const uri=${JSON.stringify(uri)}; const d=await notebooks.get({uri}); await notebooks.update({target:{uri},expectedRevision:d.handle.revision,operations:[{op:"insert",at:{index:0},cells:${JSON.stringify(cells)}}]}); await notebooks.show(uri); const next=await notebooks.get({uri}); console.log(next.notebook.cells.map(c=>({refId:c.refId,value:c.value})));`
  )
  assert.equal(seeded.length, 2)
  const target = JSON.stringify({ uri })
  await code(
    `await notebooks.execute({target:${target},refIds:[${JSON.stringify(seeded[1].refId)}]});`
  )
  const initialVersion = await code(
    `const versions=await revisions.list({target:${target}}); const v=versions.at(-1);console.log(await revisions.label({target:${target},revisionId:v.id,name:"Initial checklist",description:"Before addressing review comments"}));`
  )
  await page
    .getByRole('button', { name: 'Review suggestions', exact: true })
    .click()
  await page
    .getByRole('heading', { name: 'Review rounds', exact: true })
    .waitFor()
  await page.getByLabel('Review round', { exact: true }).selectOption('new')
  await page.getByRole('checkbox', { name: 'Named revisions only' }).check()
  await page
    .getByLabel('End revision', { exact: true })
    .selectOption(initialVersion.id)
  await page
    .getByRole('button', { name: 'Start review', exact: true })
    .waitFor()
  await page.waitForFunction(() =>
    document
      .querySelector('#review-round-canvas')
      ?.textContent?.includes('Preview')
  )
  assert.equal(await page.getByLabel('New review comment').count(), 0)
  await checkpoint('00-named-revision-live-preview')
  const first = await code(
    `console.log(await reviews.create({target:${target},title:"Round 1 · initial checklist",startRevisionId:"empty",endRevisionId:${JSON.stringify(initialVersion.id)}}));`
  )
  assert.equal(first.after.cells.length, 2)
  assert.ok(
    first.after.cells[1].outputs.length > 0,
    'Captured review includes output'
  )
  await page
    .getByRole('button', { name: 'Continue review', exact: true })
    .waitFor()
  assert.equal(
    (
      await code(
        `console.log(await reviews.create({target:${target},startRevisionId:"empty",endRevisionId:${JSON.stringify(initialVersion.id)}}));`
      )
    ).id,
    first.id
  )
  await checkpoint('00a-continue-existing-pair')
  await page.getByLabel('Review round', { exact: true }).selectOption(first.id)
  assert.equal(
    await page.getByLabel('Start revision', { exact: true }).count(),
    0
  )
  await checkpoint('01-fixed-initial-review')
  const thread = await code(
    `console.log(await comments.add({target:${target},reviewId:${JSON.stringify(first.id)},cellId:${JSON.stringify(seeded[0].refId)},content:"Please name the health checks and rollback criteria."}));`
  )
  const whole = await code(
    `console.log(await comments.add({target:${target},reviewId:${JSON.stringify(first.id)},content:"Also explain who owns the rollout."}));`
  )
  await code(
    `await reviews.submit({target:${target},reviewId:${JSON.stringify(first.id)},outcome:"needs_more_work",summary:"Clarify the operational checks before the next review."});`
  )
  await page
    .getByText('Please name the health checks and rollback criteria.', {
      exact: true,
    })
    .waitFor()
  await checkpoint('02-request-changes-and-discussions')
  const panel = page.getByRole('complementary', { name: 'Notebook review' })
  assert.equal(await panel.getByLabel('Discussion target').count(), 0)
  assert.equal(
    await panel.getByRole('region', { name: 'Review discussion' }).count(),
    1
  )
  assert.equal(
    await panel
      .getByText('Please name the health checks and rollback criteria.', {
        exact: true,
      })
      .count(),
    0
  )
  assert.equal(
    await panel
      .getByText('Also explain who owns the rollout.', { exact: true })
      .count(),
    1
  )
  const quoteStart = seeded[0].value.indexOf('service')
  const selectedComment = await code(
    `const c=await comments.add({target:${target},reviewId:${JSON.stringify(first.id)},cellId:${JSON.stringify(seeded[0].refId)},side:"head",sourceRange:{start:${quoteStart},end:${quoteStart + 7},unit:"utf-16"},content:"Selected text stays beside this cell.",author:{displayName:"Codex",kind:"agent"}}); console.log(c);`
  )
  assert.equal(
    JSON.parse(selectedComment.anchor).runme.diffTarget.quote,
    'service'
  )
  await page
    .getByText('Selected text stays beside this cell.', { exact: true })
    .waitFor()
  assert.equal(
    await panel
      .getByText('Selected text stays beside this cell.', { exact: true })
      .count(),
    0
  )
  await checkpoint('02a-one-review-conversation-inline-selection')
  const revised =
    '# Release checklist\n\nVerify two healthy replicas and no new errors for five minutes. Roll back if either check fails.'
  await code(
    `const uri=${JSON.stringify(uri)}; const d=await notebooks.get({uri}); await notebooks.update({target:{uri},expectedRevision:d.handle.revision,operations:[{op:"update",refId:${JSON.stringify(seeded[0].refId)},patch:{value:${JSON.stringify(revised)}}}]}); await comments.reply({target:{uri},commentId:${JSON.stringify(thread.id)},content:"Added replica, error-rate, and rollback checks.",author:{displayName:"Codex",kind:"agent"}});`
  )
  const second = await code(
    `const versions=await revisions.list({target:${target}});const head=versions.at(-1);await revisions.label({target:${target},revisionId:head.id,name:"Version",description:"Codex addressed comments",author:{displayName:"Codex",kind:"agent"}});console.log(await reviews.create({target:${target},title:"Round 2 · operational checks",startRevisionId:${JSON.stringify(initialVersion.id)},endRevisionId:head.id}));`
  )
  assert.equal(second.before.cells[0].value, first.after.cells[0].value)
  assert.equal(second.after.cells[0].value, revised)
  for (const id of [thread.id, whole.id])
    await code(
      `await reviews.linkThread({target:${target},reviewId:${JSON.stringify(second.id)},commentId:${JSON.stringify(id)}});`
    )
  await page.getByLabel('Review round', { exact: true }).selectOption(second.id)
  await page
    .getByText('Added replica, error-rate, and rollback checks.', {
      exact: true,
    })
    .waitFor()
  assert.match(
    await page.locator('#review-round-canvas').innerText(),
    /Outdated context/
  )
  await checkpoint('03-incremental-diff-shared-thread')
  const suggestions = await code(
    `console.log(await suggestions.list({target:${target}}));`
  )
  const suggestion = suggestions.at(-1)
  await page
    .getByRole('button', {
      name: 'Individual suggestions · accept/reject',
      exact: true,
    })
    .click()
  await page.getByLabel('Next suggestion', { exact: true }).waitFor()
  for (let index = 1; index < suggestions.length; index++)
    await page.getByLabel('Next suggestion', { exact: true }).click()
  assert.equal(
    await page.locator('[data-suggestion-comment-thread]').count(),
    0
  )
  await checkpoint('03a-suggestion-without-discussion')
  const explanation = await code(
    `console.log(await comments.add({target:${target},suggestionId:${JSON.stringify(suggestion.id)},content:"This edit makes the rollout checks actionable.",author:{displayName:"Codex",kind:"agent"}}));`
  )
  await code(
    `await comments.reply({target:${target},commentId:${JSON.stringify(explanation.id)},content:"The original change and decision remain unchanged.",author:{displayName:"Codex",kind:"agent"}});`
  )
  assert.deepEqual(
    await code(`console.log(await suggestions.list({target:${target}}));`),
    suggestions
  )
  await page
    .getByText('The original change and decision remain unchanged.', {
      exact: true,
    })
    .waitFor()
  assert.equal(
    await page.locator('[data-suggestion-comment-thread]').count(),
    1
  )
  await checkpoint('03b-api-created-suggestion-discussion')
  await page
    .getByRole('button', { name: 'Back to review rounds', exact: true })
    .click()
  await page.getByLabel('Review round', { exact: true }).selectOption(first.id)
  const historical = await code(
    `console.log((await reviews.list({target:${target}})).find(r=>r.id===${JSON.stringify(first.id)}));`
  )
  assert.deepEqual(historical.diff, first.diff)
  await checkpoint('04-original-review-unchanged')
  await page.getByLabel('Review round', { exact: true }).selectOption(second.id)
  await code(
    `await comments.resolve({target:${target},commentId:${JSON.stringify(thread.id)}}); await reviews.submit({target:${target},reviewId:${JSON.stringify(second.id)},outcome:"good_enough",summary:"The checks are clear. Ownership discussion remains open."});`
  )
  await page.locator('#review-submit').scrollIntoViewIfNeeded()
  await checkpoint('05-approved-with-open-followup')
  const beforeReload = await code(
    `console.log({rounds:await reviews.list({target:${target}}),comments:await comments.list({target:${target},status:"all"})});`
  )
  await page.reload()
  await page
    .getByRole('heading', { name: 'Review rounds', exact: true })
    .waitFor()
  const afterReload = await code(
    `console.log({rounds:await reviews.list({target:${target}}),comments:await comments.list({target:${target},status:"all"})});`
  )
  assert.deepEqual(afterReload, beforeReload)
  assert.equal(
    afterReload.comments.find((c) => c.id === whole.id).resolved,
    false
  )
  await checkpoint('06-reload-preserves-review-and-authors')
  // Decisions operate on the live journal, never on a frozen review snapshot.
  await page
    .getByRole('button', {
      name: 'Individual suggestions · accept/reject',
      exact: true,
    })
    .click()
  for (let index = 1; index < suggestions.length; index++)
    await page.getByLabel('Next suggestion', { exact: true }).click()
  await page.getByRole('button', { name: 'Reject', exact: true }).click()
  await page.getByText('Rejected', { exact: true }).waitFor()
  const rejected = await code(
    `console.log({doc:await notebooks.get({uri:${JSON.stringify(uri)}}),rounds:await reviews.list({target:${target}})});`
  )
  assert.equal(rejected.doc.notebook.cells[0].value, first.after.cells[0].value)
  assert.deepEqual(rejected.rounds, beforeReload.rounds)
  await checkpoint('07-reject-leaves-historical-reviews-fixed')
  await page.getByRole('button', { name: 'Accept', exact: true }).click()
  await page.getByText('Accepted', { exact: true }).waitFor()
  const accepted = await code(
    `console.log({doc:await notebooks.get({uri:${JSON.stringify(uri)}}),rounds:await reviews.list({target:${target}})});`
  )
  assert.equal(accepted.doc.notebook.cells[0].value, revised)
  assert.deepEqual(accepted.rounds, beforeReload.rounds)
  await checkpoint('08-accept-restores-live-edit-only')
  // A second dedicated notebook exercises section-scoped reviews, not only the
  // original whole-document path. All changes still use registered WebMCP.
  const scopeFixture = await code(`
    const d=await notebooks.createLocal("section-review-recording.runme"); const uri=d.handle.uri;
    const values=["# Runbook","## Setup","Original setup checklist","### Old credentials","Retired credential flow","## Rollout","Rollout unchanged"];
    await notebooks.update({target:{uri},expectedRevision:d.handle.revision,operations:[{op:"insert",at:{index:0},cells:values.map(value=>({kind:"markup",languageId:"markdown",value}))}]});
    const old=await notebooks.get({uri}); const start=(await revisions.list({target:{uri}})).at(-1);
    await notebooks.update({target:{uri},expectedRevision:old.handle.revision,operations:[{op:"update",refId:old.notebook.cells[2].refId,patch:{value:"Verify the new setup checklist"}},{op:"remove",refIds:[old.notebook.cells[3].refId,old.notebook.cells[4].refId]}]});
    const end=(await revisions.list({target:{uri}})).at(-1); await notebooks.show(uri);
    console.log({uri,start:start.id,end:end.id,ids:old.notebook.cells.map(c=>c.refId)});
  `)
  const scopedPair = {
    target: { uri: scopeFixture.uri },
    startRevisionId: scopeFixture.start,
    endRevisionId: scopeFixture.end,
  }
  await page
    .getByRole('button', { name: 'Review suggestions', exact: true })
    .click()
  await page
    .getByRole('heading', { name: 'Review rounds', exact: true })
    .waitFor()
  await page
    .getByLabel('Start revision', { exact: true })
    .selectOption(scopeFixture.start)
  await page
    .getByLabel('End revision', { exact: true })
    .selectOption(scopeFixture.end)
  await page
    .getByRole('radio', { name: 'Heading / section range', exact: true })
    .check()
  await page
    .getByLabel('From heading', { exact: true })
    .selectOption(`${scopeFixture.ids[1]}:1`)
  await page.waitForFunction(() => {
    const text =
      document.querySelector('#review-round-canvas')?.textContent ?? ''
    return (
      text.includes('Verify the new setup checklist') &&
      !text.includes('Rollout unchanged')
    )
  })
  await checkpoint('09-section-preview-excludes-unrelated-cells')
  const section = await code(
    `console.log(await reviews.create(${JSON.stringify({ ...scopedPair, title: 'Setup section', cellIds: scopeFixture.ids.slice(1, 3) })}));`
  )
  await page
    .getByRole('button', { name: 'Continue review', exact: true })
    .waitFor()
  await page
    .getByLabel('Review round', { exact: true })
    .selectOption(section.id)
  await page
    .getByLabel('Review outcome', { exact: true })
    .selectOption('good_enough')
  await code(
    `await reviews.submit(${JSON.stringify({ target: scopedPair.target, reviewId: section.id, outcome: 'good_enough' })});`
  )
  await checkpoint('10-good-enough-fixed-section')
  await page.getByLabel('Review round', { exact: true }).selectOption('new')
  await page
    .getByLabel('Start revision', { exact: true })
    .selectOption(scopeFixture.start)
  await page
    .getByRole('radio', { name: 'Heading / section range', exact: true })
    .check()
  await page
    .getByLabel('Scope outline revision', { exact: true })
    .selectOption('base')
  await page
    .getByLabel('From heading', { exact: true })
    .selectOption(`${scopeFixture.ids[3]}:1`)
  await page.waitForFunction(() => {
    const text =
      document.querySelector('#review-round-canvas')?.textContent ?? ''
    return (
      text.includes('Retired credential flow') &&
      !text.includes('Rollout unchanged')
    )
  })
  await checkpoint('11-start-outline-selects-deleted-section')
  const deleted = await code(
    `console.log(await reviews.create(${JSON.stringify({ ...scopedPair, title: 'Deleted credential section', cellIds: scopeFixture.ids.slice(3, 5) })}));`
  )
  await page
    .getByLabel('Review round', { exact: true })
    .selectOption(deleted.id)
  await code(
    `await reviews.submit(${JSON.stringify({ target: scopedPair.target, reviewId: deleted.id, outcome: 'needs_more_work' })});`
  )
  const scopeReadback = await code(
    `const a=await reviews.create(${JSON.stringify({ ...scopedPair, cellIds: [scopeFixture.ids[4], scopeFixture.ids[3], scopeFixture.ids[4]] })}); console.log({duplicate:a.id,rounds:await reviews.list({target:${JSON.stringify(scopedPair.target)}})});`
  )
  assert.equal(scopeReadback.duplicate, deleted.id)
  assert.equal(scopeReadback.rounds.length, 2)
  assert.deepEqual(scopeReadback.rounds.map((r) => r.outcome).sort(), [
    'good_enough',
    'needs_more_work',
  ])
  await page.reload()
  await page
    .getByRole('heading', { name: 'Review rounds', exact: true })
    .waitFor()
  const scopeReopened = await code(
    `console.log(await reviews.list({target:${JSON.stringify(scopedPair.target)}}));`
  )
  assert.deepEqual(scopeReopened, scopeReadback.rounds)
  const scopedCanvas = page
    .getByRole('tabpanel', {
      name: 'Suggestions · section-review-recording.runme',
      exact: true,
    })
    .locator('#review-round-canvas')
  assert.ok(
    (await scopedCanvas.innerText()).includes('Retired credential flow')
  )
  assert.ok(!(await scopedCanvas.innerText()).includes('Rollout unchanged'))
  await checkpoint('12-scoped-decisions-survive-reload')
  evidence.scopedReviewIds = [section.id, deleted.id]
  evidence.status = 'passed'
  evidence.roundIds = [first.id, second.id]
  evidence.threadIds = [thread.id, whole.id, explanation.id]
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
