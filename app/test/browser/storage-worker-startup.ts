import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { type Page, chromium } from 'playwright-core'

/** Poll an asynchronous browser observation with an actual awaited result. */
async function until(
  page: Page,
  predicate: () => Promise<unknown>,
  label: string
) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}`)
}

/** Hold a real IndexedDB transaction ahead of the emitted worker's settings read.
 * This exercises Chromium scheduling rather than mocking a request callback.
 */
async function main() {
  const base = process.env.RUNME_TEST_URL ?? 'http://127.0.0.1:5198'
  await fetch(`${base}/test/promote?release=b`, { method: 'POST' })
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
  })
  const output = 'test/browser/test-output/storage-worker-startup'
  await mkdir(output, { recursive: true })
  const events: unknown[] = []
  const watchdog = setTimeout(() => void browser.close(), 90000)
  let contextForDiagnostics:
    | import('playwright-core').BrowserContext
    | undefined
  try {
    const context = await browser.newContext()
    contextForDiagnostics = context
    const page = await context.newPage()
    page.on('console', (message) => events.push(message.text()))
    await page.goto(`${base}/recovery.html`)
    // Recovery is inert until the user chooses a release. Prepare and activate
    // explicitly before testing worker diagnostics and a real IndexedDB stall.
    await page
      .getByRole('button', { name: 'Check for updates', exact: true })
      .click()
    await page
      .getByRole('button', {
        name: 'Activate release and update this tab',
        exact: true,
      })
      .click()
    await until(
      page,
      async () => Boolean((await (window as any).runmeVersions?.get())?.active),
      'initial owner activation'
    )
    const identity = await page.evaluate(async () => {
      const w = window as any
      w.active = (await w.runmeVersions.get()).active
      w.pageIdentity = crypto.randomUUID()
      w.events = []
      w.management = new BroadcastChannel('runme-storage-worker-control-v1')
      w.management.onmessage = ({ data }: MessageEvent) => {
        if (!data.status) return
        w.events.push(data)
        w.workerStatus = data.status
      }
      w.startOwner = () => {
        const { manifest, epoch } = w.active
        w.worker = new SharedWorker(
          `/version/${manifest.releaseId}/${manifest.owner.entry}`,
          {
            type: 'module',
            name: `runme-storage-owner-${manifest.releaseId}-${epoch}`,
          }
        )
        w.worker.port.start()
      }
      return w.pageIdentity
    })
    await until(
      page,
      async () => {
        const w = window as any
        w.management.postMessage({ type: 'discover' })
        return w.workerStatus?.phase === 'ready'
      },
      'ready owner diagnostics'
    )
    await page.evaluate(() => {
      const w = window as any
      w.management.postMessage({
        type: 'stop',
        instanceId: w.workerStatus.instanceId,
        force: true,
        restart: false,
      })
    })
    await until(
      page,
      async () =>
        navigator.locks.request(
          'runme-storage-owner-lifetime-v1',
          { ifAvailable: true },
          (lock) => Boolean(lock)
        ),
      'old owner exit'
    )
    await page.evaluate(async () => {
      const w = window as any
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('runme-release-control')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const tx = db.transaction('state', 'readwrite')
      const table = tx.objectStore('state')
      // Keep this transaction active without changing any settings or notebook.
      const keepAlive = () => {
        table.get('control').onsuccess = keepAlive
      }
      keepAlive()
      w.releaseDatabase = () => {
        tx.abort()
        db.close()
      }
      w.workerStatus = undefined
      w.startOwner()
    })
    await until(
      page,
      async () => {
        const w = window as any
        w.management.postMessage({ type: 'discover' })
        return (
          w.workerStatus?.phase === 'reading-release-settings' &&
          w.workerStatus.releaseDatabase?.active?.some(
            (trace: any) => trace.phase === 'get-requested'
          )
        )
      },
      'queued settings get visible before runtime initialization'
    )
    const queued = await page.evaluate(() => (window as any).workerStatus)
    await page.evaluate(() => {
      const w = window as any
      w.management.postMessage({
        type: 'stop',
        instanceId: w.workerStatus.instanceId,
        force: false,
        restart: false,
      })
    })
    await until(
      page,
      async () => {
        const w = window as any
        w.management.postMessage({ type: 'discover' })
        return w.workerStatus?.phase === 'draining'
      },
      'graceful drain still observable'
    )
    await page.evaluate(() => {
      const w = window as any
      w.management.postMessage({
        type: 'stop',
        instanceId: w.workerStatus.instanceId,
        force: true,
        restart: false,
      })
    })
    await until(
      page,
      async () =>
        navigator.locks.request(
          'runme-storage-owner-lifetime-v1',
          { ifAvailable: true },
          (lock) => Boolean(lock)
        ),
      'force close bypasses stalled initialization'
    )
    await page.evaluate(() => {
      const w = window as any
      w.workerStatus = undefined
      w.startOwner()
    })
    await until(
      page,
      async () => {
        const w = window as any
        w.management.postMessage({ type: 'discover' })
        return (
          w.workerStatus?.phase === 'failed' &&
          w.workerStatus.releaseDatabase?.failures?.length > 0
        )
      },
      'real queued get timeout reported'
    )
    const timedOut = await page.evaluate(() => (window as any).workerStatus)
    await page.evaluate(() => {
      const w = window as any
      w.management.postMessage({
        type: 'stop',
        instanceId: w.workerStatus.instanceId,
        force: true,
        restart: false,
      })
    })
    await until(
      page,
      async () =>
        navigator.locks.request(
          'runme-storage-owner-lifetime-v1',
          { ifAvailable: true },
          (lock) => Boolean(lock)
        ),
      'failed owner exit'
    )
    await page.evaluate(() => {
      const w = window as any
      w.releaseDatabase()
      w.workerStatus = undefined
      w.startOwner()
    })
    await until(
      page,
      async () => {
        const w = window as any
        w.management.postMessage({ type: 'discover' })
        return w.workerStatus?.phase === 'ready'
      },
      'replacement initializes after the blocking transaction ends'
    )
    assert.equal(
      await page.evaluate(() => (window as any).pageIdentity),
      identity
    )
    await writeFile(
      `${output}/result.json`,
      JSON.stringify(
        {
          passed: true,
          queued,
          timedOut,
          replacement: await page.evaluate(() => (window as any).workerStatus),
        },
        null,
        2
      )
    )
    console.log(
      'PASS: real IndexedDB get stall is observable; force close bypasses a stalled drain; replacement starts without page reload'
    )
  } finally {
    const diagnostics = await Promise.all(
      contextForDiagnostics?.pages().map(async (page) =>
        page
          .evaluate(() => ({
            status: (window as any).workerStatus,
            events: (window as any).events,
          }))
          .catch((error) => ({ error: String(error) }))
      ) ?? []
    )
    await writeFile(
      `${output}/diagnostics.json`,
      JSON.stringify(diagnostics, null, 2)
    )
    clearTimeout(watchdog)
    await writeFile(`${output}/browser.log`, events.join('\n'))
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
