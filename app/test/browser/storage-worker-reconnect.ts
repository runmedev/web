import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { type Page, chromium } from 'playwright-core'

/** Await the actual asynchronous probe result, rather than a truthy Promise. */
async function waitForOwner(page: Page, previous: string) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const ready = await page.evaluate(async (old) => {
      const w = window as any
      if (w.recovery.getSnapshot().phase === 'required')
        await w.store.getMetadata(w.uri)
      if (w.recovery.getSnapshot().phase !== 'healthy') return false
      try {
        return (await w.recovery.diagnose()).instanceId !== old
      } catch {
        return false
      }
    }, previous)
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `Owner did not reconnect: ${JSON.stringify(await page.evaluate(() => (window as any).recovery.getSnapshot()))}`
  )
}

/** Exercise the actual tab store, SharedWorker and OPFS in a disposable profile.
 * Run against Vite development serving this checkout; no live credentials/data.
 */
async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
  })
  const output = 'test/browser/test-output/storage-worker-reconnect'
  await mkdir(output, { recursive: true })
  const watchdog = setTimeout(() => void browser.close(), 90000)
  const logs: string[] = []
  try {
    const context = await browser.newContext()
    const base = process.env.RUNME_TEST_URL ?? 'http://127.0.0.1:5194'
    await context.route('**/reconnect-test', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Storage reconnect</title><p>Disposable storage lifecycle test</p>',
      })
    )
    const pages = [await context.newPage(), await context.newPage()]
    for (const page of pages) {
      page.on('console', (message) => logs.push(message.text()))
      page.on('pageerror', (error) => logs.push(String(error)))
      await page.goto(`${base}/reconnect-test`)
      await page.evaluate(async () => {
        const w = window as any
        w.pageIdentity = crypto.randomUUID()
        // Drop only a successful editor-commit reply, after the actual OPFS write.
        // The tab must keep the same batch and deduplicate it on the new owner.
        const NativeWorker = SharedWorker
        w.SharedWorker = class extends NativeWorker {
          constructor(...args: ConstructorParameters<typeof SharedWorker>) {
            super(...args)
            w.lastWorkerArgs = args
            const ids = new Set<string>()
            const send = this.port.postMessage.bind(this.port)
            this.port.postMessage = (message: any) => {
              if (message.method === 'commitEditorOperations')
                ids.add(message.id)
              send(message)
            }
            const descriptor = Object.getOwnPropertyDescriptor(
              MessagePort.prototype,
              'onmessage'
            )!
            Object.defineProperty(this.port, 'onmessage', {
              set(handler) {
                descriptor.set!.call(this, (event: MessageEvent) => {
                  if (
                    w.dropReply &&
                    event.data.type === 'result' &&
                    !event.data.error &&
                    ids.has(event.data.id)
                  ) {
                    w.lostReply = true
                    return
                  }
                  handler?.(event)
                })
              },
            })
          }
        }
        const clientPath = '/src/storage/storageOwnerClient.ts'
        const drivePath = '/src/storage/drive.ts'
        const protoPath = '/src/runme/client.ts'
        const controlPath = '/src/storage/storageRecovery.ts'
        const protobufPath = '/test/browser/reconnect-fixture.ts'
        w.createProto = (await import(protobufPath)).create
        const { createSharedNotebookStore } = await import(clientPath)
        const { DriveNotebookStore } = await import(drivePath)
        w.proto = (await import(protoPath)).parser_pb
        w.recovery = (await import(controlPath)).storageRecovery
        w.recovery.subscribe(() =>
          console.log(
            'RECOVERY',
            w.pageIdentity,
            JSON.stringify(w.recovery.getSnapshot())
          )
        )
        const watch = new BroadcastChannel('runme-storage-worker-control-v1')
        watch.onmessage = ({ data }) =>
          console.log('MANAGEMENT', w.pageIdentity, JSON.stringify(data))
        w.store = createSharedNotebookStore(
          new DriveNotebookStore(async () => {
            throw new Error('No test credentials')
          })
        )
        await w.store.ready
        w.passive = new NativeWorker(
          ...(w.lastWorkerArgs as ConstructorParameters<typeof SharedWorker>)
        )
        w.passive.port.start()
      })
    }
    const identities = await Promise.all(
      pages.map((page) => page.evaluate(() => (window as any).pageIdentity))
    )
    const original = await pages[0].evaluate(async () => {
      const w = window as any
      const file = await w.store.create('local://folder/local', 'restart.runme')
      w.uri = file.uri
      w.view = await w.store.createOperationLogSaveStore(file.uri)
      w.editor = w.view.initialNotebook
      w.editor.cells.push(
        w.createProto(w.proto.CellSchema, {
          refId: 'first',
          kind: w.proto.CellKind.MARKUP,
          value: 'Original',
        })
      )
      await w.view.save(file.uri, w.editor)
      return {
        uri: file.uri,
        instance: (await w.recovery.diagnose()).instanceId,
      }
    })
    await pages[1].evaluate(async (uri) => {
      const w = window as any
      w.uri = uri
      w.view = await w.store.createOperationLogSaveStore(uri)
      w.editor = w.view.initialNotebook
    }, original.uri)
    await pages[0].evaluate(() => {
      const w = window as any
      w.dropReply = true
      w.editor.cells[0].value = 'Committed before worker stop'
      w.saveResult = w.view.save(w.uri, w.editor).catch((error: Error) => {
        w.saveError = String(error)
      })
    })
    await pages[0].waitForFunction(() => (window as any).lostReply, undefined, {
      timeout: 20000,
    })
    await pages[1].evaluate(async () => {
      const w = window as any
      w.editor.cells.push(
        w.createProto(w.proto.CellSchema, {
          refId: 'other',
          kind: w.proto.CellKind.MARKUP,
          value: 'Other tab content',
        })
      )
      await w.view.save(w.uri, w.editor)
    })
    const before = await pages[1].evaluate(() =>
      (window as any).store.loadContent((window as any).uri)
    )
    await pages[0].evaluate(() => {
      const w = window as any
      w.dropReply = false
      w.recovery.restart(true)
    })
    for (const page of pages) await waitForOwner(page, original.instance)
    assert.deepEqual(
      await Promise.all(
        pages.map((page) => page.evaluate(() => (window as any).pageIdentity))
      ),
      identities,
      'Neither page may reload'
    )
    assert.equal(
      await pages[0].evaluate(() =>
        (window as any).store.loadContent((window as any).uri)
      ),
      before,
      'Retry must not duplicate the committed batch'
    )
    await pages[0].evaluate(async () => {
      const w = window as any
      w.editor.cells[0].value = 'Edited after reconnect'
      await w.view.save(w.uri, w.editor)
    })
    const cells = await pages[1].evaluate(async () =>
      (
        await (window as any).store.loadOperationLogSnapshot(
          (window as any).uri
        )
      ).cells.map((cell: any) => cell.value)
    )
    console.log('Force restart completed')
    assert.deepEqual(cells, ['Edited after reconnect', 'Other tab content'])
    const forceInstance = await pages[0].evaluate(
      async () => (await (window as any).recovery.diagnose()).instanceId
    )
    await pages[0].evaluate(() => (window as any).recovery.restart())
    for (const page of pages) await waitForOwner(page, forceInstance)
    assert.deepEqual(
      await Promise.all(
        pages.map((page) => page.evaluate(() => (window as any).pageIdentity))
      ),
      identities
    )
    console.log('Graceful restart completed')
    // Idle tabs do not need immediate reconnection. Each can join on its next
    // request without waiting for, or sending readiness messages to, another tab.
    const beforeStop = await pages[0].evaluate(
      async () => (await (window as any).recovery.diagnose()).instanceId
    )
    await pages[0].evaluate(async () => {
      const path = '/src/storage/storageWorkerControl.ts'
      const { StorageWorkerControl } = await import(path)
      await new Promise<void>((resolve) => {
        const control = new StorageWorkerControl((event: any) => {
          if (event.type !== 'status') return
          control.stop(event.status.instanceId, { force: true, restart: false })
          control.close()
          resolve()
        })
        control.discover()
      })
    })
    for (const page of pages)
      await page.waitForFunction(
        () => (window as any).recovery.getSnapshot().phase === 'required'
      )
    await pages[1].evaluate(async () => {
      const w = window as any
      w.editor.cells[1].value = 'Saved by idle tab after stop'
      await w.view.save(w.uri, w.editor)
    })
    for (const page of pages) await waitForOwner(page, beforeStop)
    assert.deepEqual(
      await Promise.all(
        pages.map((page) => page.evaluate(() => (window as any).pageIdentity))
      ),
      identities
    )
    const finalCells = await pages[0].evaluate(async () =>
      (
        await (window as any).store.loadOperationLogSnapshot(
          (window as any).uri
        )
      ).cells.map((cell: any) => cell.value)
    )
    assert.deepEqual(finalCells, [
      'Edited after reconnect',
      'Saved by idle tab after stop',
    ])
    const ownerIds = await Promise.all(
      pages.map((page) =>
        page.evaluate(
          async () => (await (window as any).recovery.diagnose()).instanceId
        )
      )
    )
    assert.equal(
      ownerIds[0],
      ownerIds[1],
      'Independent retries join the same worker'
    )
    await writeFile(
      `${output}/result.json`,
      JSON.stringify(
        {
          passed: true,
          pagesPreserved: identities,
          cells,
          lostReplyDeduplicated: true,
          forceRestart: true,
          gracefulRestart: true,
          independentRetryAfterStop: true,
          finalCells,
          ownerIds,
        },
        null,
        2
      )
    )
    console.log(
      'PASS: force and graceful restarts preserve both pages; lost save reply is deduplicated; concurrent edits survive'
    )
  } finally {
    clearTimeout(watchdog)
    await writeFile(`${output}/browser.log`, logs.join('\n'))
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
