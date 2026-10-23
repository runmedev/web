import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { type Page, chromium } from 'playwright-core'

/** Verify restart of the real emitted SharedWorker using disposable pages and browser storage. */
async function main() {
  const source = await readFile('src/storage/storageOwnerProtocol.ts', 'utf8')
  const version = Number(source.match(/STORAGE_OWNER_VERSION = (\d+)/)?.[1])
  if (!version) throw new Error('Could not resolve storage protocol version')
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    timeout: 20000,
  })
  console.log('Chromium launched')
  try {
    const context = await browser.newContext()
    const base = process.env.RUNME_TEST_URL ?? 'http://127.0.0.1:5194'
    await context.route('**/recovery-test', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Storage recovery test</title><p>Testing shared storage restart.</p>',
      })
    )
    const pages = [await context.newPage(), await context.newPage()]
    /** Install the tab side of the stable recovery control plane; never use live credentials. */
    const connect = async (page: Page) =>
      page.evaluate(async (version) => {
        const worker = new SharedWorker('/storage-owner.js', {
          type: 'module',
          name: 'runme-storage-owner',
        })
        const pending = new Map<
          string,
          { resolve: (value: any) => void; reject: (error: Error) => void }
        >()
        worker.port.onmessage = ({ data }) => {
          if (data.type === 'storage-recovery') {
            if (data.action === 'prepare') {
              sessionStorage.setItem(
                'recovery-test-copy',
                'editor contents preserved'
              )
              worker.port.postMessage({
                type: 'storage-recovery',
                protocol: 1,
                action: 'ready',
                id: data.id,
              })
            }
            if (data.action === 'reload') {
              worker.port.close()
              location.reload()
            }
            return
          }
          const request = pending.get(data.id)
          if (!request) return
          pending.delete(data.id)
          if (data.error) request.reject(new Error(data.error.message))
          else request.resolve(data.value)
        }
        worker.port.start()
        const call = (
          method: string,
          args: unknown[] = [],
          wireVersion = version
        ) =>
          new Promise<any>((resolve, reject) => {
            const id = crypto.randomUUID()
            const timer = setTimeout(
              () => reject(new Error('Worker request timed out')),
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
              version: wireVersion,
              id,
              method,
              args,
            })
          })
        const diagnose = () =>
          new Promise<any>((resolve, reject) => {
            const id = crypto.randomUUID()
            const timer = setTimeout(
              () => reject(new Error('Diagnostics timed out')),
              5000
            )
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(timer)
                resolve(value)
              },
              reject,
            })
            worker.port.postMessage({ type: 'storage-owner-diagnostics', id })
          })
        ;(window as any).recoveryTest = {
          diagnose,
          call,
          restart: () =>
            worker.port.postMessage({
              type: 'storage-recovery',
              protocol: 1,
              action: 'restart',
              id: crypto.randomUUID(),
            }),
        }
        await call('hello', [{ attempts: [] }])
      }, version)
    await Promise.all(
      pages.map(async (page) => {
        await page.goto(`${base}/recovery-test`)
        await connect(page)
      })
    )
    console.log('Both tabs connected')
    const diagnostics = await pages[0].evaluate(() =>
      (window as any).recoveryTest.diagnose()
    )
    if (
      diagnostics.connectedTabs !== 2 ||
      diagnostics.initialization !== 'ready'
    )
      throw new Error(
        `Unexpected worker diagnostics: ${JSON.stringify(diagnostics)}`
      )
    const original = await pages[0].evaluate(async () => {
      const { call } = (window as any).recoveryTest
      const file = await call('create', [
        'local://folder/local',
        'restart-survivor.runme',
      ])
      const bytes = await call('loadContent', [file.uri])
      let mismatch = false
      try {
        await call('save', [file.uri, {}], 0)
      } catch (error) {
        mismatch = String(error).includes('version mismatch')
      }
      if (!mismatch) throw new Error('Expected data protocol mismatch')
      return { uri: file.uri, bytes: Array.from(bytes) }
    })
    console.log('Durable notebook created and mismatch rejected')
    const cdp = await browser.newBrowserCDPSession()
    const before = await cdp.send('Target.getTargets')
    const owners = before.targetInfos.filter(
      (t) => t.type === 'shared_worker' && t.url.endsWith('/storage-owner.js')
    )
    if (owners.length !== 1)
      throw new Error(`Expected one storage owner, got ${owners.length}`)
    console.log('Requesting restart')
    const navigations = pages.map((page) => page.waitForEvent('load'))
    await pages[0].evaluate(() => (window as any).recoveryTest.restart())
    await Promise.all(navigations)
    console.log('Both tabs reloaded')
    for (const page of pages) {
      if (
        (await page.evaluate(() =>
          sessionStorage.getItem('recovery-test-copy')
        )) !== 'editor contents preserved'
      )
        throw new Error('Editor recovery copy missing')
    }
    await Promise.all(pages.map(connect))
    const after = await cdp.send('Target.getTargets')
    if (after.targetInfos.some((t) => t.targetId === owners[0].targetId))
      throw new Error('Old shared worker did not terminate')
    const restored = await pages[0].evaluate(
      async (uri) =>
        Array.from(
          await (window as any).recoveryTest.call('loadContent', [uri])
        ),
      original.uri
    )
    if (JSON.stringify(restored) !== JSON.stringify(original.bytes))
      throw new Error('Durable notebook bytes changed during restart')
    await pages[0].evaluate(() => {
      document.body.textContent =
        'PASS: two tabs reloaded, old worker terminated, editor copies survived, durable notebook bytes unchanged, new storage owner connected.'
    })
    await mkdir('test/browser/test-output', { recursive: true })
    await pages[0].screenshot({
      path: 'test/browser/test-output/storage-owner-recovery.png',
    })
    await writeFile(
      'test/browser/test-output/storage-owner-recovery.json',
      JSON.stringify(
        {
          passed: true,
          tabs: 2,
          oldWorkerTerminated: true,
          durableBytesUnchanged: true,
        },
        null,
        2
      )
    )
    console.log(
      'PASS: emitted worker coordinated restart, two tabs, recovery copies and exact durable bytes'
    )
    await context.close()
    // A frontend-only worker fixture reproduces the legacy mismatch before React mounts.
    const legacy = await browser.newContext()
    await legacy.route('**/storage-owner.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `self.onconnect = event => {
        const port = event.ports[0];
        port.onmessage = ({data}) => {
          if (data.type === 'request') port.postMessage({type:'result', id:data.id,
            error:{name:'Error',message:'Storage worker version mismatch. Reload all Runme tabs to reconnect.'}});
        };
        port.start();
      };`,
      })
    )
    const ui = await legacy.newPage()
    await ui.goto(base)
    await ui
      .locator('#storage-recovery-notebook')
      .getByRole('button', { name: 'Restart Runme' })
      .waitFor()
    await ui.screenshot({
      path: 'test/browser/test-output/storage-recovery-notebook.png',
    })
    await ui
      .getByRole('button', { name: /Google Drive status:/ })
      .click({ button: 'right' })
    await ui.getByRole('menuitem', { name: 'Status', exact: true }).click()
    const status = ui.locator('#storage-recovery-storage-status')
    await status.getByRole('button', { name: 'Restart Runme' }).waitFor()
    await status.getByRole('button', { name: 'Restart Runme' }).click()
    await status
      .getByText(/did not acknowledge restart/)
      .waitFor({ timeout: 15000 })
    await status.getByRole('button', { name: 'Restart Runme' }).waitFor()
    await status.getByRole('button', { name: 'Get recovery copies' }).click()
    await status
      .getByText('No loaded editable notebooks are open in this tab.')
      .waitFor()
    if (
      !(await status
        .getByText(/Copies do not survive closing this tab/)
        .count())
    )
      throw new Error('Recovery fallback must disclose session-copy lifetime')
    await ui.screenshot({
      path: 'test/browser/test-output/storage-recovery-status.png',
    })
    console.log(
      'PASS: notebook and storage-status controls, startup mismatch, safe legacy fallback'
    )
    await legacy.close()
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
