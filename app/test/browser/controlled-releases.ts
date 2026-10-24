import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { type Page, chromium } from 'playwright-core'

const base = process.env.RUNME_TEST_URL ?? 'http://127.0.0.1:5199'
const output = 'test/browser/test-output/controlled-releases'

/** Exercise real emitted launcher, service worker, SharedWorkers, IndexedDB and
 * OPFS. Only the static publication server and WebMCP transport are test fixtures.
 */
async function main() {
  await mkdir(output, { recursive: true })
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    timeout: 20000,
  })
  console.log('Chromium started')
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: {
      dir: output + '/videos',
      size: { width: 1440, height: 1000 },
    },
  })
  await context.addInitScript(() => {
    const tools = new Map<string, any>()
    ;(window as any).__releaseTools = tools
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool(tool: any, options?: { signal?: AbortSignal }) {
          tools.set(tool.name, tool)
          options?.signal?.addEventListener('abort', () => {
            if (tools.get(tool.name) === tool) tools.delete(tool.name)
          })
        },
      },
    })
  })
  console.log('Context initialized')
  const errors: string[] = []
  context.on('page', (page) =>
    page.on('pageerror', (error) => errors.push(error.message))
  )
  const pages: Page[] = []
  const ready = async (page: Page) => {
    await page.waitForFunction(
      () =>
        (window as any).__releaseTools?.has('ExecuteCode') &&
        typeof (window as any).runmeRelease?.prepare === 'function' &&
        !document.getElementById('root')?.inert,
      undefined,
      { timeout: 60000 }
    )
  }
  const execute = async (page: Page, code: string): Promise<string> => {
    let result = await page.evaluate(
      async (code) =>
        JSON.parse(
          await (window as any).__releaseTools
            .get('ExecuteCode')
            .execute({ code, timeoutMs: 1000 })
        ),
      code
    )
    while (['running', 'queued'].includes(result.status))
      result = await page.evaluate(
        async (id) =>
          JSON.parse(
            await (window as any).__releaseTools
              .get('GetExecuteCodeOperation')
              .execute({ operationId: id, waitMs: 1000 })
          ),
        result.operationId
      )
    assert.equal(result.exitCode, 0, JSON.stringify(result))
    return result.output.events.map((e: any) => e.text).join('')
  }
  // Playwright's waitForFunction tests the immediate return value; a Promise is
  // truthy even if it later resolves false. Await control transactions in Node.
  const waitControl = async (
    page: Page,
    predicate: (state: any) => boolean
  ) => {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const state = await page.evaluate(() =>
        (window as any).runmeVersions.get()
      )
      if (predicate(state)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for durable release state')
  }
  const openVersions = async (page: Page) => {
    await page
      .getByRole('button', { name: 'Open Version Information', exact: true })
      .click()
    await page.getByRole('region', { name: 'Application versions' }).waitFor()
    await page.locator('#runme-release-panel').waitFor({ state: 'hidden' })
  }
  const active = (page: Page) =>
    page.evaluate(() => (window as any).runmeRelease?.active.manifest.releaseId)
  try {
    const expected = (await fetch(base + '/test/releases').then((r) =>
      r.json()
    )) as { a: string; b: string }
    await fetch(base + '/test/promote?release=a', { method: 'POST' })
    console.log('Published fixture A')
    const legacy = await context.newPage()
    await legacy.goto(base + '/test/legacy-page')
    let one = await context.newPage()
    pages.push(one)
    console.log('Page created')
    await one.goto(base + '/?session=release-one', {
      waitUntil: 'domcontentloaded',
    })
    console.log('Launcher loaded')
    await one
      .getByRole('status')
      .filter({ hasText: 'close all older Runme tabs' })
      .waitFor({ timeout: 30000 })
    assert.equal(await active(one), undefined)
    await legacy.close()
    await fetch(base + '/test/fonts?blocked=1', { method: 'POST' })
    await one.reload()
    const downloadProgress = one.getByRole('progressbar', {
      name: 'Release files verified',
    })
    await downloadProgress.waitFor({ state: 'visible', timeout: 30000 })
    assert.ok(Number(await downloadProgress.getAttribute('max')) > 0)
    await one.screenshot({ path: output + '/00-download-progress.png' })
    await ready(one)
    await one.waitForFunction(() => {
      const api = (window as any).runmeVersions
      const id = (window as any).runmeRelease?.active.manifest.releaseId
      return id && api.offline(id)?.phase === 'error'
    })
    assert.ok(
      await one.evaluate(async () => {
        const id = (window as any).runmeRelease.active.manifest.releaseId
        const choices = await (window as any).runmeVersions.cached()
        const full = await (
          await caches.open(`runme-release-v1-${id}`)
        ).match(`/version/${id}/release.json`)
        return !full && choices.some((choice: any) => choice.releaseId === id)
      }),
      'Startup-ready release must remain a recovery choice without its fonts'
    )
    await openVersions(one)
    await one
      .getByText('The app is ready. Some fonts are not yet available offline.')
      .waitFor()
    await one.screenshot({ path: output + '/00-app-ready-without-fonts.png' })
    await fetch(base + '/test/fonts?blocked=0', { method: 'POST' })
    await one
      .getByRole('button', { name: 'Retry offline font download' })
      .click()
    await one
      .getByText('All release files are verified and cached for offline use.')
      .waitFor({ timeout: 60000 })
    console.log(
      'PASS: app opens with fonts unavailable; background retry completes offline cache'
    )
    console.log(
      'PASS: unknown legacy window blocks new storage ownership until closed'
    )
    const a = await active(one)
    assert.match(a, /^a{40}-b{64}$/)
    const two = await context.newPage()
    pages.push(two)
    await two.goto(base + '/?session=release-two')
    await ready(two)
    assert.equal(await active(two), a)
    await fetch(base + '/test/promote?release=b', { method: 'POST' })
    await one.reload()
    await ready(one)
    assert.equal(await active(one), a)
    await waitControl(one, (s) => s.candidate?.releaseId === expected.b)
    const three = await context.newPage()
    pages.push(three)
    await three.goto(base + '/?session=release-three')
    await ready(three)
    assert.equal(
      await three.evaluate(
        async () =>
          (await (window as any).runmeVersions.get()).active.manifest.releaseId
      ),
      a
    )
    console.log('PASS: deploy B; refresh and new tabs retain A')
    await openVersions(one)
    await one.screenshot({ path: output + '/00-version-information.png' })
    await one
      .getByRole('button', { name: 'Pin installed release', exact: true })
      .click()
    await waitControl(
      one,
      (s) =>
        s.selection.kind === 'pinned' &&
        s.selection.releaseId === a &&
        !s.candidate
    )
    await one
      .getByRole('button', { name: 'Check for updates', exact: true })
      .click()
    await waitControl(one, (s) => s.candidate?.releaseId === a)
    assert.equal(await active(one), a)
    await one
      .getByRole('button', { name: 'Follow latest', exact: true })
      .click()
    await waitControl(
      one,
      (s) =>
        s.selection.name === 'latest' && s.candidate?.releaseId === expected.b
    )
    await one
      .getByRole('button', { name: 'Follow stable', exact: true })
      .click()
    await waitControl(
      one,
      (s) =>
        s.selection.name === 'stable' && s.candidate?.releaseId === expected.b
    )
    assert.equal(await active(one), a)
    console.log(
      'PASS: Information view owns controls; exact pin and channel selection never activate implicitly'
    )

    const created = await execute(
      one,
      `const d=await notebooks.createLocal('upgrade-one.runme'); await notebooks.appendCell({target:{uri:d.handle.uri},kind:'markup',value:'Before upgrade: durable edit'}); await notebooks.show(d.handle.uri); console.log(d.handle.uri);`
    )
    const uri = created.match(/local:\/\/file\/[^\s]+/)![0]
    await execute(
      two,
      `const d=await notebooks.createLocal('upgrade-two.runme');await notebooks.appendCell({target:{uri:d.handle.uri},kind:'markup',value:'Second tab survives'});await notebooks.show(d.handle.uri);`
    )
    await one.screenshot({ path: output + '/01-two-tabs-a.png' })
    // A failed preparation must block all tabs, even though the other tabs save.
    await two.evaluate(() => {
      const runtime = (window as any).runmeRelease
      ;(window as any).__realPrepare = runtime.prepare
      runtime.prepare = async () => {
        throw new Error('Injected durable-save failure')
      }
    })
    await openVersions(one)
    await one
      .getByRole('button', { name: 'Upgrade all tabs', exact: true })
      .click()
    await one
      .locator('#runme-release-panel')
      .getByRole('status')
      .filter({ hasText: 'Injected durable-save failure' })
      .waitFor({ timeout: 30000 })
    assert.equal(await active(one), a)
    assert.equal(await active(two), a)
    await one.screenshot({ path: output + '/02-blocked-save.png' })
    console.log('PASS: unconfirmed durable save blocks activation')
    await two.evaluate(() => {
      ;(window as any).runmeRelease.prepare = (window as any).__realPrepare
    })
    const oldTabId = await one.evaluate(
      () => (window as any).runmeRelease.tabId
    )
    await one
      .locator('#runme-release-panel')
      .getByRole('button', { name: 'Cancel upgrade', exact: true })
      .click()
    await one.waitForFunction(
      (id) =>
        (window as any).runmeRelease?.tabId &&
        (window as any).runmeRelease.tabId !== id,
      oldTabId
    )
    await ready(one)
    assert.match(
      await execute(
        one,
        `console.log((await notebooks.get({uri:${JSON.stringify(uri)}})).notebook.cells.map(c=>c.value).join('\\n'))`
      ),
      /Before upgrade/
    )
    console.log('PASS: cancellation reloads prepared tabs from durable state')
    // Hold readiness as well as requesting browser freeze: Chromium may wake a
    // frozen page when another tab opens. Neither missing readiness nor loss of
    // the initiating tab permits the coordinator to discard this participant.
    await ready(two)
    await ready(three)
    await waitControl(three, (s) => !s.transition)
    await two.evaluate(() => {
      const real = (window as any).runmeRelease.prepare
      ;(window as any).runmeRelease.prepare = () =>
        new Promise((resolve, reject) => {
          ;(window as any).__resumeReleasePreparation = () =>
            real().then(resolve, reject)
        })
    })
    const suspended = await context.newCDPSession(two)
    await suspended.send('Page.setWebLifecycleState', { state: 'frozen' })
    await openVersions(one)
    await one
      .getByRole('button', { name: 'Upgrade all tabs', exact: true })
      .click()
    await waitControl(
      three,
      (s) =>
        s.transition?.phase === 'prepare' &&
        Object.values(s.transition.participants).some((p: any) => p.ready)
    )
    assert.equal(
      await three.evaluate(
        async () =>
          (await (window as any).runmeVersions.get()).active.manifest.releaseId
      ),
      a
    )
    await one.close()
    one = await context.newPage()
    pages[0] = one
    await one.goto(base + '/?session=release-one')
    await one
      .getByRole('status')
      .filter({ hasText: 'waiting for tab' })
      .waitFor({ timeout: 30000 })
    assert.equal(await active(one), undefined)
    await one.screenshot({ path: output + '/02-frozen-tab-new-tab-waits.png' })
    await suspended.send('Page.setWebLifecycleState', { state: 'active' })
    await two.waitForFunction(
      () => typeof (window as any).__resumeReleasePreparation === 'function'
    )
    await two.evaluate(() => (window as any).__resumeReleasePreparation())
    await suspended.detach()
    console.log(
      'PASS: frozen tab blocks; new tab waits; another coordinator resumes after initiator closes'
    )
    for (const page of pages) {
      await page.waitForFunction(
        (id) => (window as any).runmeRelease?.active.manifest.releaseId === id,
        expected.b,
        { timeout: 60000 }
      )
      await ready(page)
    }
    const b = await active(one)
    assert.notEqual(a, b)
    assert.match(
      await execute(
        one,
        `console.log((await notebooks.get({uri:${JSON.stringify(uri)}})).notebook.cells.map(c=>c.value).join('\\n'))`
      ),
      /Before upgrade/
    )
    await one.screenshot({ path: output + '/03-upgraded-b.png' })
    console.log('PASS: all tabs upgraded and notebook edits retained')
    await one.waitForFunction(
      () => {
        const id = (window as any).runmeRelease?.active.manifest.releaseId
        return (
          id && (window as any).runmeVersions.offline(id)?.phase === 'ready'
        )
      },
      undefined,
      { timeout: 60000 }
    )
    await context.setOffline(true)
    await one.reload()
    await ready(one)
    assert.equal(await active(one), b)
    await one.screenshot({ path: output + '/04-offline-restart.png' })
    console.log('PASS: offline restart loads installed B')
    await execute(
      one,
      `await notebooks.appendCell({target:{uri:${JSON.stringify(uri)}},kind:'markup',value:'Edited on B and retained after rollback'});`
    )
    await openVersions(one)
    await one.getByText('Other releases and recovery', { exact: true }).click()
    await one
      .getByRole('button', {
        name: 'Use cached aaaaaaaa / bbbbbbbb',
        exact: true,
      })
      .click()
    for (const page of pages) {
      await page.waitForFunction(
        () =>
          (window as any).runmeRelease?.active.manifest.webCommit ===
          'a'.repeat(40),
        undefined,
        { timeout: 60000 }
      )
      await ready(page)
    }
    assert.match(
      await execute(
        one,
        `console.log((await notebooks.get({uri:${JSON.stringify(uri)}})).notebook.cells.map(c=>c.value).join('\\n'))`
      ),
      /Edited on B/
    )
    await one.screenshot({ path: output + '/05-offline-rollback.png' })
    console.log('PASS: compatible offline rollback keeps edits made on B')
    const recovery = await context.newPage()
    pages.push(recovery)
    await recovery.goto(base + '/recovery.html')
    await recovery
      .getByRole('button', { name: 'Check for updates', exact: true })
      .waitFor({ timeout: 30000 })
    assert.equal(await recovery.locator('#root').textContent(), '')
    await recovery.screenshot({ path: output + '/06-independent-recovery.png' })
    console.log(
      'PASS: recovery selector works without importing the application'
    )
    if (process.env.RUNME_TEST_BROKEN) {
      await context.setOffline(false)
      await fetch(base + '/test/promote?release=broken', { method: 'POST' })
      await one.evaluate(() => (window as any).runmeVersions.check())
      await openVersions(one)
      await one
        .getByRole('button', { name: 'Upgrade all tabs', exact: true })
        .click()
      await one.waitForFunction(
        () =>
          (window as any).runmeRelease?.active.manifest.webCommit ===
          'e'.repeat(40),
        undefined,
        { timeout: 60000 }
      )
      await one.waitForFunction(
        () => document.querySelector('#root')?.childElementCount === 0
      )
      // Recovery's UI belongs to the loader, so it survives a verified but broken
      // app entry. Close failed app tabs to prove they cannot hold unsaved edits.
      await recovery
        .getByRole('button', {
          name: 'Use cached aaaaaaaa / bbbbbbbb',
          exact: true,
        })
        .waitFor({ timeout: 30000 })
      await recovery.screenshot({
        path: output + '/07-broken-entry-selector.png',
      })
      await Promise.all([one, two, three].map((page) => page.close()))
      await recovery
        .getByRole('button', {
          name: 'Use cached aaaaaaaa / bbbbbbbb',
          exact: true,
        })
        .click()
      const restored = await context.newPage()
      pages.splice(0, 3, restored)
      await restored.goto(base + '/?session=release-one')
      await ready(restored)
      assert.equal(await active(restored), a)
      assert.match(
        await execute(
          restored,
          `console.log((await notebooks.get({uri:${JSON.stringify(uri)}})).notebook.cells.map(c=>c.value).join('\\n'))`
        ),
        /Edited on B/
      )
      console.log(
        'PASS: broken entry recovery retains current notebook contents'
      )
      await fetch(base + '/test/promote?release=broken-owner', {
        method: 'POST',
      })
      await restored.evaluate(() => (window as any).runmeVersions.check())
      await openVersions(restored)
      await restored
        .getByRole('button', { name: 'Upgrade all tabs', exact: true })
        .click()
      await waitControl(
        recovery,
        (s) => s.transition?.phase === 'handoff' && Boolean(s.ownerError)
      )
      assert.equal(await active(restored), a)
      await recovery
        .getByRole('status')
        .filter({ hasText: 'Storage startup failed' })
        .waitFor({ timeout: 30000 })
      await recovery.screenshot({
        path: output + '/08-broken-owner-selector.png',
      })
      await recovery
        .getByRole('button', {
          name: 'Use cached aaaaaaaa / bbbbbbbb',
          exact: true,
        })
        .click()
      await waitControl(
        recovery,
        (s) => !s.transition && s.active?.manifest.releaseId === a
      )
      await ready(restored)
      assert.match(
        await execute(
          restored,
          `console.log((await notebooks.get({uri:${JSON.stringify(uri)}})).notebook.cells.map(c=>c.value).join('\\n'))`
        ),
        /Edited on B/
      )
      console.log(
        'PASS: broken owner handoff recovers to the prior release without losing current data'
      )
    }
    await writeFile(
      output + '/result.json',
      JSON.stringify({ passed: true, a, b, errors }, null, 2)
    )
  } catch (error) {
    for (let i = 0; i < pages.length; i++) {
      await pages[i]
        .screenshot({ path: output + `/failure-${i}.png` })
        .catch(() => {})
      const state = await pages[i]
        .evaluate(async () => ({
          text: document.body.innerText,
          state: await (window as any).runmeVersions?.get(),
        }))
        .catch(String)
      await writeFile(
        output + `/failure-${i}.json`,
        JSON.stringify(state, null, 2)
      )
      console.error('Page', i, typeof state === 'object' ? state.text : state)
    }
    console.error('Browser errors', errors)
    throw error
  } finally {
    await context.close()
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
