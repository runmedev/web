import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

/** Exercise the public ExecuteCode handler with unavailable optional databases.
 * The Go publisher serves real app/worker assets; only IDB opens are faulted. */
async function main() {
  const base = process.env.RUNME_TEST_URL ?? 'http://127.0.0.1:5198'
  const output = 'test/browser/test-output/controlled-releases'
  await mkdir(output, { recursive: true })
  await fetch(base + '/test/promote?release=b', { method: 'POST' })
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
  })
  try {
    const context = await browser.newContext()
    await context.addInitScript(() => {
      const tools = new Map()
      ;(window as any).__executeTools = tools
      Object.defineProperty(document, 'modelContext', {
        configurable: true,
        value: {
          registerTool(tool: any) {
            tools.set(tool.name, tool)
          },
        },
      })
    })
    const page = await context.newPage()
    await page.goto(base + '/?session=execute-storage-cuj')
    await page.waitForFunction(
      () => (window as any).__executeTools.has('ExecuteCode'),
      undefined,
      { timeout: 60000 }
    )
    const healthy = await page.evaluate(async () => {
      const tool = (window as any).__executeTools.get('ExecuteCode')
      const request = {
        code: "console.log('normal-storage');",
        idempotencyKey: 'healthy-check',
        timeoutMs: 2000,
      }
      const first = JSON.parse(await tool.execute(request))
      const retry = JSON.parse(await tool.execute(request))
      return { first, retry }
    })
    assert.equal(healthy.first.status, 'succeeded')
    assert.equal(healthy.first.persistence, 'indexeddb')
    assert.equal(healthy.retry.operationId, healthy.first.operationId)
    // Seed history in this disposable profile, then close the seed connection.
    await page.evaluate(async () => {
      const request = indexedDB.open('runme-app-console', 10)
      request.onupgradeneeded = () => {
        const db = request.result
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' })
        sessions.createIndex('updatedAt', 'updatedAt')
        sessions.createIndex('createdAt', 'createdAt')
        const cells = db.createObjectStore('cells', { keyPath: 'id' })
        cells.createIndex('sessionId', 'sessionId')
        cells.createIndex('[sessionId+index]', ['sessionId', 'index'])
        cells.createIndex('updatedAt', 'updatedAt')
      }
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const tx = db.transaction(['sessions', 'cells'], 'readwrite')
        const sessionId = `tab:${new URL(location.href).searchParams.get('session')}`
        tx.objectStore('sessions').put({
          id: sessionId,
          createdAt: '2026-10-31T00:00:00Z',
          updatedAt: '2026-10-31T00:00:00Z',
        })
        tx.objectStore('cells').put({
          id: 'preserved-draft',
          sessionId,
          index: 1,
          status: 'draft',
          source: 'saved draft must survive',
          outputs: [],
          updatedAt: '2026-10-31T00:00:00Z',
        })
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve()
          tx.onabort = () => reject(tx.error)
        })
      } finally {
        db.close()
      }
    })
    await page.addInitScript(() => {
      const open = indexedDB.open.bind(indexedDB)
      ;(window as any).__originalOpen = open
      indexedDB.open = ((name: string, version?: number) => {
        if (['runme-app-console', 'runme-code-operations'].includes(name))
          return {} as IDBOpenDBRequest
        return open(name, version)
      }) as typeof indexedDB.open
    })
    await page.reload()
    await page.waitForFunction(
      () => (window as any).__executeTools.has('ExecuteCode'),
      undefined,
      { timeout: 60000 }
    )
    const started = Date.now()
    const result = await page.evaluate(async () =>
      JSON.parse(
        await (window as any).__executeTools.get('ExecuteCode').execute({
          code: "console.log('health-check');",
          timeoutMs: 1000,
          timeoutBehavior: 'cancel',
          maxRuntimeMs: 2000,
        })
      )
    )
    assert(
      Date.now() - started < 10000,
      'Execution must return before the browser transport deadline'
    )
    assert(result.operationId)
    assert.equal(result.status, 'succeeded')
    assert.equal(result.persistence, 'memory')
    assert(
      result.output.events.some((event: any) =>
        event.text.includes('health-check')
      )
    )
    // Read the underlying database through the original API, proving the memory
    // fallback did not overwrite the unread draft or delete its session.
    const draft = await page.evaluate(async () => {
      const request = (window as any).__originalOpen(
        'runme-app-console'
      ) as IDBOpenDBRequest
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const read = db
          .transaction('cells', 'readonly')
          .objectStore('cells')
          .get('preserved-draft')
        return await new Promise<any>((resolve, reject) => {
          read.onsuccess = () => resolve(read.result)
          read.onerror = () => reject(read.error)
        })
      } finally {
        db.close()
      }
    })
    assert.equal(draft.source, 'saved draft must survive')
    await page.getByLabel('Open App Console', { exact: true }).click()
    await page.getByText('health-check', { exact: false }).first().waitFor()
    assert.equal(
      await page.getByText('Loading console history…', { exact: true }).count(),
      0
    )
    await page.screenshot({
      path: output + '/execute-code-storage-unavailable.png',
    })
    await writeFile(
      output + '/execute-code-storage-result.json',
      JSON.stringify({
        result,
        preservedDraft: true,
        elapsedMs: Date.now() - started,
      })
    )
    console.log(
      'PASS: ExecuteCode returns health-check output with blocked console/operation databases; saved draft survives'
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
