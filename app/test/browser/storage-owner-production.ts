import { chromium } from 'playwright-core'

/** Verify the emitted module worker, including its worker-safe parser dependencies. */
async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox'],
  })
  try {
    const page = await browser.newPage()
    const base = process.env.RUNME_TEST_URL ?? 'http://127.0.0.1:5194'
    await page.route('**/owner-test', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Isolated worker test</title>',
      })
    )
    await page.goto(`${base}/owner-test`)
    const result = await page.evaluate(async () => {
      const worker = new SharedWorker('/storage-owner.js', {
        type: 'module',
        name: 'runme-storage-owner',
      })
      const pending = new Map<
        string,
        { resolve: (value: any) => void; reject: (error: Error) => void }
      >()
      worker.port.onmessage = ({ data }) => {
        if (data.type !== 'result') return
        const request = pending.get(data.id)
        if (!request) return
        pending.delete(data.id)
        if (data.error) request.reject(new Error(data.error.message))
        else request.resolve(data.value)
      }
      worker.onerror = () => {
        for (const request of pending.values())
          request.reject(new Error('Production worker failed'))
      }
      worker.port.start()
      const call = (method: string, args: unknown[] = []) =>
        new Promise<any>((resolve, reject) => {
          const id = crypto.randomUUID()
          const timer = setTimeout(
            () => reject(new Error('Production worker timed out')),
            15000
          )
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(timer)
              resolve(value)
            },
            reject: (error) => {
              clearTimeout(timer)
              reject(error)
            },
          })
          worker.port.postMessage({
            type: 'request',
            version: 1,
            id,
            method,
            args,
          })
        })
      await call('hello', [{ attempts: [] }])
      const notebook = await call('create', [
        'local://folder/local',
        'production-worker.runme',
      ])
      const bytes = await call('loadContent', [notebook.uri])
      const snapshot = await call('loadOperationLogSnapshot', [notebook.uri])
      worker.port.postMessage({
        type: 'request',
        version: 1,
        id: 'end',
        method: 'disconnect',
        args: [],
      })
      worker.port.close()
      return { hasBytes: bytes.length > 0, cells: snapshot.cells.length }
    })
    if (!result.hasBytes || result.cells !== 0)
      throw new Error(
        'Production worker did not persist and parse the notebook'
      )
    console.log(
      'PASS: emitted storage-owner.js handshake, durable creation and notebook decoding'
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
