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
  const installTools = () => {
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
  }
  await context.addInitScript(installTools)
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
        document.getElementById('main-page') !== null &&
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
    assert.equal(
      await one.evaluate(() => {
        const runtime = (window as any).runmeRelease
        // Notebook edits repeat this notification. They must not restart a
        // completed font job and rehash the whole release on every edit.
        runtime.ready()
        return (window as any).runmeVersions.offline(
          runtime.active.manifest.releaseId
        )?.phase
      }),
      'ready',
      'Repeated app readiness must not restart completed offline caching'
    )
    console.log(
      'PASS: app opens with fonts unavailable; background retry completes offline cache'
    )
    console.log(
      'PASS: unknown legacy window blocks new storage ownership until closed'
    )
    const a = await active(one)
    assert.equal(a, expected.a)
    const two = await context.newPage()
    pages.push(two)
    await two.goto(base + '/?session=release-two')
    await ready(two)
    assert.equal(await active(two), a)
    // A controlled tab can start from cache even if browser registration
    // readiness is stalled. Keep real service workers, caches and app admission;
    // only stall the two browser promises that must not gate a warm startup.
    const warm = await context.newPage()
    try {
      await warm.addInitScript(() => {
        Object.defineProperty(navigator.serviceWorker, 'ready', {
          get: () => new Promise(() => {}),
        })
        navigator.serviceWorker.getRegistration = () => new Promise(() => {})
        // Model an older app that cannot acknowledge the version UI handoff.
        let api: any
        Object.defineProperty(window, 'runmeVersions', {
          configurable: true,
          get: () => api,
          set: (value) => {
            delete value.registerVersionUi
            api = value
          },
        })
      })
      await warm.goto(base + '/?session=release-warm-start')
      await ready(warm)
      assert.equal(await active(warm), a)
      await warm.locator('#runme-release-panel').waitFor({ state: 'visible' })
      await warm
        .locator('#runme-release-panel')
        .getByRole('button', { name: 'Versions', exact: true })
        .click()
      await warm
        .locator('#runme-release-panel')
        .getByRole('button', { name: 'Check for updates', exact: true })
        .waitFor()
      const trace = JSON.parse(
        (await warm.locator('#runme-startup-diagnostics-log').textContent()) ||
          '[]'
      )
      assert.ok(
        trace.some(
          (event: any) =>
            event.attrs.stage === 'application-ready' &&
            event.attrs.state === 'completed'
        )
      )
      await warm.screenshot({
        path: output + '/warm-start-stalled-registration.png',
      })
      console.log(
        'PASS: cached startup does not wait for registration readiness'
      )
      console.log(
        'PASS: clients without version UI handoff retain visible fallback controls and startup diagnostics'
      )
    } finally {
      await warm.close()
    }
    // A stuck settings open must not strand the launcher. Keep the real DB and
    // workers for retry/admission, injecting only the browser operation failure.
    const settings = await context.newPage()
    try {
      await settings.addInitScript(() => {
        const open = indexedDB.open.bind(indexedDB)
        let stalled = false
        indexedDB.open = ((name: string, version?: number) => {
          if (name === 'runme-release-control' && !stalled) {
            stalled = true
            return {} as IDBOpenDBRequest
          }
          return open(name, version)
        }) as typeof indexedDB.open
      })
      await settings.goto(base + '/?session=settings-transient-failure')
      await ready(settings)
      assert.equal(await active(settings), a)
      await waitControl(
        settings,
        (s) => s.selection.kind === 'channel' && s.selection.name === 'stable'
      )
      const trace = await settings
        .locator('#runme-startup-diagnostics-log')
        .textContent()
      assert.ok(trace?.includes('release-settings-open'))
      assert.ok(trace?.includes('startup-fallback'))
      await settings.screenshot({
        path: output + '/settings-transient-recovered.png',
      })
      console.log(
        'PASS: stalled settings open automatically recovers through stable and normal admission'
      )
    } finally {
      await settings.close()
    }
    const unavailable = await context.newPage()
    try {
      await unavailable.addInitScript(() => {
        const open = indexedDB.open.bind(indexedDB)
        ;(window as any).__settingsUnavailable = true
        indexedDB.open = ((name: string, version?: number) => {
          if (
            name === 'runme-release-control' &&
            (window as any).__settingsUnavailable
          )
            return {} as IDBOpenDBRequest
          return open(name, version)
        }) as typeof indexedDB.open
      })
      await unavailable.goto(base + '/?session=settings-unavailable')
      await unavailable
        .getByRole('button', { name: 'Retry latest stable', exact: true })
        .waitFor({ timeout: 60000 })
      assert.equal(await active(unavailable), undefined)
      assert.equal(await active(one), a)
      await unavailable
        .getByRole('button', { name: 'Try latest channel', exact: true })
        .waitFor()
      await unavailable
        .getByRole('button', { name: 'Try exact release', exact: true })
        .waitFor()
      await unavailable.screenshot({
        path: output + '/settings-unavailable-recovery.png',
      })
      await unavailable.evaluate(() => {
        ;(window as any).__settingsUnavailable = false
      })
      await unavailable
        .getByRole('button', { name: 'Retry latest stable', exact: true })
        .click()
      await ready(unavailable)
      assert.equal(await active(unavailable), a)
      await unavailable.screenshot({
        path: output + '/settings-manual-recovered.png',
      })
      console.log(
        'PASS: unavailable settings expose independent recovery controls and retry preserves normal ownership'
      )
    } finally {
      await unavailable.close()
    }
    // Model Chromium losing an external large-value file. Keep real notebook
    // storage, locks, schema upgrades and workers; fail only the v1 control get.
    const damagedContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    })
    await damagedContext.addInitScript(installTools)
    try {
      const original = await damagedContext.newPage()
      await original.goto(base + '/?session=damaged-settings')
      await ready(original)
      const savedUri = (
        await execute(
          original,
          `const d=await notebooks.createLocal('settings-recovery.runme'); await notebooks.show(d.handle.uri); await notebooks.appendCell({target:{uri:d.handle.uri},kind:'markup',value:'Preserve this notebook through settings recovery'}); console.log(d.handle.uri)`
        )
      ).trim()
      // Seed a mounted folder in the real notebook database, independently of
      // the control database being damaged. Verify the actual Explorer restores
      // it before and after repair, not just that notebook payloads survive.
      await original.evaluate(async () => {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('runme-local-notebooks')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result
            const tx = db.transaction('folders', 'readwrite')
            tx.objectStore('folders').put({
              id: 'local://folder/recovery-fixture',
              remoteId: 'local://folder/recovery-fixture',
              name: 'Preserved workspace folder',
              children: [],
            })
            tx.oncomplete = () => {
              db.close()
              resolve()
            }
            tx.onabort = tx.onerror = () => {
              db.close()
              reject(tx.error)
            }
          }
        })
        const workspace = JSON.parse(localStorage.getItem('runme/workspace')!)
        workspace.items.push('local://folder/recovery-fixture')
        localStorage.setItem('runme/workspace', JSON.stringify(workspace))
      })
      await original.evaluate(() => (window as any).runmeRelease.prepare())
      await original.reload()
      await ready(original)
      await original
        .getByText('Preserved workspace folder', { exact: true })
        .waitFor()
      assert.match(
        await execute(
          original,
          `console.log((await notebooks.get({uri:${JSON.stringify(savedUri)}})).notebook.cells.map(c=>c.value).join('\\n'))`
        ),
        /Preserve this notebook/,
        'The setup must be durable before injecting damage'
      )
      await original.close()
      const repaired = await damagedContext.newPage()
      await repaired.addInitScript(() => {
        const get = IDBObjectStore.prototype.get
        IDBObjectStore.prototype.get = function (key) {
          if (
            this.transaction.db.name === 'runme-release-control' &&
            this.transaction.db.version === 1 &&
            this.name === 'state' &&
            key === 'control'
          ) {
            const request = {
              error: new DOMException(
                'Missing large value file',
                'NotReadableError'
              ),
              onerror: null as null | (() => void),
            }
            queueMicrotask(() => request.onerror?.())
            return request as unknown as IDBRequest
          }
          return get.call(this, key)
        }
      })
      await repaired.goto(base + '/?session=damaged-settings')
      // Closing the prior page can briefly leave its worker alive. Never evict
      // it; allow automatic repair or retry once the real lifetime lock is free.
      await repaired.waitForFunction(
        () =>
          Boolean((window as any).runmeRelease) ||
          [...document.querySelectorAll('button')].some(
            (button) => button.textContent === 'Retry latest stable'
          ),
        undefined,
        { timeout: 60000 }
      )
      if (
        await repaired
          .getByRole('button', { name: 'Retry latest stable', exact: true })
          .isVisible()
      ) {
        const deadline = Date.now() + 60000
        while (
          await repaired.evaluate(async () =>
            (await navigator.locks.query()).held?.some(
              (lock) => lock.name === 'runme-storage-owner-lifetime-v1'
            )
          )
        ) {
          if (Date.now() > deadline)
            throw new Error('Old owner did not release after tab closed')
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        await repaired
          .getByRole('button', { name: 'Retry latest stable', exact: true })
          .click()
      }
      await ready(repaired)
      await repaired
        .getByText('Preserved workspace folder', { exact: true })
        .waitFor()
      const repairState = await repaired.evaluate(() =>
        (window as any).runmeVersions.get()
      )
      assert.equal(repairState.recoveredControlFormat, 1)
      assert.ok(repairState.active.epoch > 1)
      assert.match(
        await execute(
          repaired,
          `console.log((await notebooks.get({uri:${JSON.stringify(savedUri)}})).notebook.cells.map(c=>c.value).join('\\n'))`
        ),
        /Preserve this notebook/
      )
      const schema = await repaired.evaluate(
        () =>
          new Promise<{ version: number; stores: string[]; encoding: string }>(
            (resolve, reject) => {
              const request = indexedDB.open('runme-release-control')
              request.onerror = () => reject(request.error)
              request.onsuccess = () => {
                const db = request.result
                const get = db
                  .transaction('state')
                  .objectStore('state')
                  .get('control')
                get.onsuccess = () => {
                  resolve({
                    version: db.version,
                    stores: Array.from(db.objectStoreNames),
                    encoding: get.result.encoding,
                  })
                  db.close()
                }
                get.onerror = () => {
                  reject(get.error)
                  db.close()
                }
              }
            }
          )
      )
      assert.equal(schema.version, 2)
      assert.ok(schema.stores.includes('unreadable-state-1'))
      assert.equal(schema.encoding, 'runme-control-json-chunks-v1')
      await repaired.reload()
      await ready(repaired)
      await repaired
        .getByText('Preserved workspace folder', { exact: true })
        .waitFor()
      assert.match(
        await execute(
          repaired,
          `console.log((await notebooks.get({uri:${JSON.stringify(savedUri)}})).notebook.cells.map(c=>c.value).join('\\n'))`
        ),
        /Preserve this notebook/
      )
      await repaired.screenshot({
        path: output + '/settings-quarantined-recovered.png',
      })
      console.log(
        'PASS: irrecoverable settings are quarantined; notebooks survive recovery and reload'
      )
    } catch (error) {
      for (const page of damagedContext.pages()) {
        console.error(
          'Damaged-profile diagnostics',
          await page.locator('body').innerText().catch(String)
        )
        await page
          .screenshot({ path: output + '/settings-repair-failure.png' })
          .catch(() => {})
      }
      throw error
    } finally {
      await damagedContext.close()
    }
    await fetch(base + '/test/promote?release=b', { method: 'POST' })
    await one.reload()
    await ready(one)
    assert.equal(await active(one), a)
    if (process.env.RUNME_RELEASE_BASELINE) {
      // Historical service workers cannot learn a new bootstrap while still
      // controlling old windows. Verify the explicit migration entrypoint.
      await one.goto(
        `${base}/version/${expected.b}/launcher.html?session=release-one`
      )
      await ready(one)
      assert.equal(await active(one), a)
    }
    assert.equal(
      await one.evaluate(() => document.documentElement.dataset.runmeLauncher),
      expected.b,
      'Refresh must use launcher B even while the installed app and existing worker remain A'
    )
    assert.equal(
      await one.evaluate(
        () => document.documentElement.dataset.runmeLauncherSource
      ),
      'latest'
    )
    await one.screenshot({ path: output + '/latest-launcher-older-app.png' })
    console.log(
      'PASS: latest launcher B loads selected app A alongside existing A tabs'
    )
    // A slow bootstrap is already a safe protocol-1 participant, even before
    // its launcher loads. Exercise the actual worker's two-second peer probe.
    const booting = await context.newPage()
    try {
      await booting.addInitScript(() => {
        const fetcher = window.fetch.bind(window)
        const timer = window.setTimeout.bind(window)
        // Keep discovery pending deterministically while CI probes the tab.
        // All service-worker deadlines remain real and unchanged.
        window.setTimeout = ((
          handler: TimerHandler,
          delay?: number,
          ...args: any[]
        ) =>
          timer(
            handler,
            delay === 4000 ? 30000 : delay,
            ...args
          )) as typeof window.setTimeout
        window.fetch = async (...args) => {
          if (args[0] === '/launcher.json')
            await new Promise<void>((resolve) => {
              ;(window as any).__finishLauncherCheck = resolve
            })
          return fetcher(...args)
        }
      })
      await booting.goto(
        `${base}/version/${expected.b}/launcher.html?session=slow-bootstrap`
      )
      await booting.waitForFunction(
        () => typeof (window as any).__finishLauncherCheck === 'function'
      )
      const reply = await one.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const channel = new MessageChannel()
            const timer = setTimeout(() => {
              channel.port1.close()
              reject(new Error('Loader peer probe stalled'))
            }, 5000)
            channel.port1.onmessage = (event) => {
              clearTimeout(timer)
              channel.port1.close()
              resolve(event.data)
            }
            navigator.serviceWorker.controller!.postMessage(
              'runme-loader-version',
              [channel.port2]
            )
          })
      )
      assert.equal(reply, 'runme-loader-1')
      assert.equal(await booting.locator('#runme-release-panel').count(), 0)
      await booting.evaluate(() => (window as any).__finishLauncherCheck())
      await ready(booting)
      assert.equal(await active(booting), a)
      console.log(
        'PASS: a tab checking the latest launcher answers peer compatibility probes'
      )
    } finally {
      await booting.close()
    }
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
    const pinFlow = one.getByRole('button', { name: 'Pin Release', exact: true })
    const hasPinFlow = await pinFlow.count() > 0
    if (hasPinFlow) {
      await pinFlow.click()
      await one.getByRole('tab', { name: 'Pin Release', exact: true }).waitFor()
      await one.screenshot({ path: output + '/00-pin-release-choices.png' })
      await one.getByRole('button', { name: /Choose another release/ }).click()
      await one.getByRole('button', { name: 'Load published releases', exact: true }).click()
      await one.getByRole('button', { name: new RegExp(`Commit ${expected.b.slice(0, 8)}`) }).click()
      await one.screenshot({ path: output + '/00-pin-release-review.png' })
      assert.equal((await one.evaluate(() => (window as any).runmeVersions.get())).selection.kind, 'channel')
      await one.getByRole('button', { name: 'Back', exact: true }).click()
      await one.getByRole('button', { name: 'Back', exact: true }).click()
      await one.getByRole('button', { name: /Keep the installed release/ }).click()
    }
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
    if (hasPinFlow) await one.getByRole('button', { name: 'Back to version information', exact: true }).click()
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
    const secondCreated = await execute(
      two,
      `const d=await notebooks.createLocal('upgrade-two.runme');await notebooks.appendCell({target:{uri:d.handle.uri},kind:'markup',value:'Second tab survives'});await notebooks.show(d.handle.uri);console.log(d.handle.uri);`
    )
    const secondUri = secondCreated.match(/local:\/\/file\/[^\s]+/)![0]
    await one.screenshot({ path: output + '/01-two-tabs-a.png' })
    const historicalApp = Boolean(process.env.RUNME_RELEASE_BASELINE)
    let incompatible: Page | undefined
    if (!historicalApp) {
      incompatible = await context.newPage()
      pages.push(incompatible)
      await incompatible.goto(base + '/?session=incompatible-peer')
      await ready(incompatible)
      await execute(
        incompatible,
        `const d=await notebooks.createLocal('incompatible.runme');await notebooks.appendCell({target:{uri:d.handle.uri},kind:'markup',value:'Preserved during compatibility recovery'});await notebooks.show(d.handle.uri);`
      )
      await incompatible.evaluate(() => {
        // Inject only the stable capability reply, leaving the actual worker,
        // lock, checkpoint, navigation and persistence paths unchanged.
        const NativeWorker = SharedWorker
        ;(window as any).SharedWorker = class extends NativeWorker {
          constructor(...args: ConstructorParameters<typeof SharedWorker>) {
            super(...args)
            const send = this.port.postMessage.bind(this.port)
            this.port.postMessage = (message: any) => {
              if (
                message.type === 'request' &&
                !['handshake', 'disconnect'].includes(message.method)
              )
                sessionStorage.setItem('incompatible-data-rpc', message.method)
              send(message)
            }
            const descriptor = Object.getOwnPropertyDescriptor(
              MessagePort.prototype,
              'onmessage'
            )!
            Object.defineProperty(this.port, 'onmessage', {
              set(handler) {
                descriptor.set!.call(this, (event: MessageEvent) => {
                  if (event.data?.value?.protocol === 1)
                    event.data.value.rpcVersion = -1
                  handler?.(event)
                })
              },
            })
          }
        }
      })
    }
    const peerId = await two.evaluate(() => (window as any).runmeRelease.tabId)
    let suspended: Awaited<ReturnType<typeof context.newCDPSession>> | undefined
    if (historicalApp) {
      // Historical launchers implement their own all-tab reload policy. Preserve
      // and close those already-durable peers before testing the migration floor.
      await Promise.all([two, three].map((page) => page.close()))
    } else {
      await two.evaluate(() => {
        const runtime = (window as any).runmeRelease
        runtime.prepare = runtime.prepareReload = async () => {
          throw new Error('Peer must never be asked to prepare')
        }
      })
      suspended = await context.newCDPSession(two)
      await suspended.send('Page.setWebLifecycleState', { state: 'frozen' })
    }
    await openVersions(one)
    await one
      .getByRole('button', {
        name: /^(Activate release and update this tab|Upgrade all tabs)$/,
        exact: true,
      })
      .click()
    await one.waitForFunction(
      (id) => (window as any).runmeRelease?.active.manifest.releaseId === id,
      expected.b,
      { timeout: 60000 }
    )
    await ready(one)
    const b = await active(one)
    assert.notEqual(a, b)
    if (!historicalApp) {
      await suspended!.send('Page.setWebLifecycleState', { state: 'active' })
      await suspended!.detach()
      assert.equal(await active(two), a)
      assert.equal(await active(three), a)
      assert.equal(
        await two.evaluate(() => (window as any).runmeRelease.tabId),
        peerId
      )
      assert.equal(
        await two.evaluate(() => document.getElementById('root')?.inert),
        false
      )
      await execute(
        two,
        `await notebooks.appendCell({target:{uri:${JSON.stringify(secondUri)}},kind:'markup',value:'Old UI saves through new worker'});`
      )
      await waitControl(
        two,
        (s) => !s.transition && s.active?.manifest.releaseId === b
      )
      assert.equal(await active(two), a, 'Saving must not reload the older UI')
      // A local backup failure must not reload this page or roll back the worker.
      const thirdId = await three.evaluate(
        () => (window as any).runmeRelease.tabId
      )
      const failedBackup = await three.evaluate(async () => {
        const set = Storage.prototype.setItem
        Storage.prototype.setItem = function (key, value) {
          if (key === 'runme/tab-editor-recovery/v1')
            throw new DOMException(
              'Injected recovery quota',
              'QuotaExceededError'
            )
          return set.call(this, key, value)
        }
        try {
          await (window as any).runmeVersions.reloadTab()
          return 'unexpected reload'
        } catch (error) {
          return String(error)
        } finally {
          Storage.prototype.setItem = set
        }
      })
      assert.match(failedBackup, /Injected recovery quota/)
      assert.equal(
        await three.evaluate(() => (window as any).runmeRelease.tabId),
        thirdId
      )
      assert.equal(await active(three), a)
      assert.equal(
        await three.evaluate(() => document.getElementById('root')?.inert),
        false
      )
      await three.evaluate(() => (window as any).runmeVersions.reloadTab())
      await three.waitForFunction(
        (id) => (window as any).runmeRelease?.active.manifest.releaseId === id,
        b
      )
      await ready(three)
      assert.equal(
        await active(two),
        a,
        'Independent reload must leave its peer alone'
      )
      console.log(
        'PASS: frozen peer cannot block activation; old UI saves to new worker; quota failure preserves its tab; independent reload leaves peer alive'
      )
    }
    assert.match(
      await execute(
        one,
        `console.log((await notebooks.get({uri:${JSON.stringify(uri)}})).notebook.cells.map(c=>c.value).join('\\n'))`
      ),
      /Before upgrade/
    )
    if (incompatible) {
      await incompatible.waitForFunction(
        (id) => (window as any).runmeRelease?.active.manifest.releaseId === id,
        b,
        { timeout: 60000 }
      )
      await ready(incompatible)
      assert.equal(
        await incompatible.evaluate(() =>
          sessionStorage.getItem('incompatible-data-rpc')
        ),
        null,
        'Incompatible connection cannot send data RPCs before recovery'
      )
      await incompatible
        .getByText('Preserved during compatibility recovery', { exact: true })
        .first()
        .waitFor()
      await incompatible.screenshot({
        path: output + '/03-incompatible-tab-recovered.png',
      })
      await incompatible.close()
      console.log(
        'PASS: confirmed capability mismatch recovers only that tab before any data RPC'
      )
    }
    await one.screenshot({ path: output + '/03-independent-upgrade-b.png' })
    console.log('PASS: initiating tab upgrades and restores notebook edits')
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
    let rollbackPeer: Page | undefined
    let rollbackPeerId: string | undefined
    if (historicalApp) {
      rollbackPeer = await context.newPage()
      pages.push(rollbackPeer)
      // The frozen service worker still serves its historical root loader.
      // Explicitly enter the current launcher to test the new peer contract.
      await rollbackPeer.goto(
        `${base}/version/${expected.b}/launcher.html?session=historical-rollback-peer`
      )
      await ready(rollbackPeer)
      assert.equal(
        await rollbackPeer.evaluate(
          () => typeof (window as any).runmeVersions.reloadTab
        ),
        'function'
      )
      rollbackPeerId = await rollbackPeer.evaluate(
        () => (window as any).runmeRelease.tabId
      )
      await execute(
        rollbackPeer,
        `const d=await notebooks.createLocal('rollback-peer.runme');await notebooks.appendCell({target:{uri:d.handle.uri},kind:'markup',value:'Keep this editor alive during historical rollback'});await notebooks.show(d.handle.uri);`
      )
    }
    await context.setOffline(true)
    if (historicalApp) {
      // Its historical service worker caches the old root launcher. Restart
      // through the cached migration entry so this tab uses the current contract.
      await one.goto(
        `${base}/version/${expected.b}/launcher.html?session=release-one`
      )
    } else await one.reload()
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
        name: `Use cached ${a.slice(0, 8)} / ${a.split('-')[1].slice(0, 8)}`,
        exact: true,
      })
      .click()
    await one.waitForFunction(
      (id) => (window as any).runmeRelease?.active.manifest.releaseId === id,
      a,
      { timeout: 60000 }
    )
    await ready(one)
    if (!historicalApp) {
      assert.equal(await active(two), a)
      assert.equal(await active(three), b, 'Rollback must not reload a peer')
    }
    assert.match(
      await execute(
        one,
        `console.log((await notebooks.get({uri:${JSON.stringify(uri)}})).notebook.cells.map(c=>c.value).join('\\n'))`
      ),
      /Edited on B/
    )
    if (rollbackPeer) {
      await waitControl(
        rollbackPeer,
        (s) => !s.transition && s.active?.manifest.releaseId === a
      )
      const reloadError = await rollbackPeer.evaluate(async () => {
        try {
          await (window as any).runmeVersions.reloadTab()
          return 'unexpected reload'
        } catch (error) {
          return String(error)
        }
      })
      assert.match(reloadError, /cannot restore this tab/)
      assert.equal(
        await rollbackPeer.evaluate(() => (window as any).runmeRelease.tabId),
        rollbackPeerId
      )
      assert.equal(await active(rollbackPeer), b)
      await rollbackPeer
        .getByText('Keep this editor alive during historical rollback', {
          exact: true,
        })
        .first()
        .waitFor()
      await rollbackPeer.screenshot({
        path: output + '/05-historical-rollback-peer-retained.png',
      })
      await rollbackPeer.close()
      console.log(
        'PASS: historical rollback flushes the initiator and refuses to discard a peer into an unsupported checkpoint reader'
      )
    }
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
        .getByRole('button', {
          name: /^(Activate release and update this tab|Upgrade all tabs)$/,
          exact: true,
        })
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
          name: `Use cached ${a.slice(0, 8)} / ${a.split('-')[1].slice(0, 8)}`,
          exact: true,
        })
        .waitFor({ timeout: 30000 })
      await recovery.screenshot({
        path: output + '/07-broken-entry-selector.png',
      })
      await Promise.all([one, two, three].map((page) => page.close()))
      await recovery
        .getByRole('button', {
          name: `Use cached ${a.slice(0, 8)} / ${a.split('-')[1].slice(0, 8)}`,
          exact: true,
        })
        .click()
      // Clicking starts asynchronous cache verification and handoff. Opening a
      // new app immediately can admit it to the still-active broken release and
      // make it a participant before recovery intent has been committed. Observe
      // completed activation, as shown by recovery status, before opening it.
      const recoveredDeadline = Date.now() + 60000
      let recovered = false
      while (Date.now() < recoveredDeadline) {
        recovered = await recovery.evaluate(async (id) => {
          const state = await (window as any).runmeVersions.get()
          return !state.transition && state.active?.manifest.releaseId === id
        }, a)
        if (recovered) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(recovered, 'Recovery must activate A before opening a new app')
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
        .getByRole('button', {
          name: /^(Activate release and update this tab|Upgrade all tabs)$/,
          exact: true,
        })
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
          name: `Use cached ${a.slice(0, 8)} / ${a.split('-')[1].slice(0, 8)}`,
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
