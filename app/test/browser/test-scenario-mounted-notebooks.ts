import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

/** Use an actual cloneable directory handle in an isolated Chrome profile.
 * Only the native picker is substituted. The application worker, timer,
 * IndexedDB, OPFS, download and file input are production entry points.
 */
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  try {
    const page = await browser.newPage()
    await page.goto(process.env.CUJ_FRONTEND_URL ?? 'http://127.0.0.1:5173/')
    const toggle = page.getByRole('button', { name: 'Toggle Explorer panel' })
    if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
    const folderName = 'Mounted notebooks'
    const name = 'sample.runme'
    const original = await page.evaluate(async ({ folderName, name }) => {
      // Load the same codecs as the Vite app under test.
      const modulePath = '/src/lib/notebookFormat.ts'
      const { createInitialNotebookFile } = await import(modulePath)
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folderName, { create: true })
      const writer = await (await dir.getFileHandle(name, { create: true })).createWritable()
      const content: string = createInitialNotebookFile(name)
      await writer.write(content)
      await writer.close()
      Object.defineProperty(window, 'showDirectoryPicker', { value: async () => dir, configurable: true })
      return content
    }, { folderName, name })
    await page.getByRole('button', { name: 'Open local folder', exact: true }).click()
    const root = page.locator('[data-node-id^="fs://"]').filter({ hasText: folderName }).first()
    await root.getByRole('button', { name: 'Expand folder' }).click()
    await page.getByText(name, { exact: true }).dblclick()
    const tab = page.getByRole('tab', { name, exact: true })
    await tab.click({ button: 'right' })
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download notebook' }).click()
    const download = await downloading
    assert.equal(download.suggestedFilename(), name)
    const bytes = await readFile((await download.path())!)
    assert.equal(JSON.parse(bytes.toString().split('\n')[0]).notebook_id,
      JSON.parse(original.split('\n')[0]).notebook_id)
    await page.locator('input[accept=".runme,.json,.ipynb"]').setInputFiles({
      name: 'imported.runme', mimeType: 'application/octet-stream', buffer: bytes,
    })
    await page.getByRole('tab', { name: 'imported.runme', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Close sample.runme', exact: true }).click()

    // A second file has a durable mirror but has never had an editor. Its only
    // wakeup after first load is the storage worker's periodic reconciliation.
    const mirror = await page.evaluate(async ({ folderName, original }) => {
      const runtimePath = '/src/lib/runtime/AppState.ts'
      const codecPath = '/src/lib/operationLog/index.ts'
      const { appState } = await import(runtimePath)
      const { parseOperationLog, createRunmeOperation, serializeOperationLog } = await import(codecPath)
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folderName)
      const file = await dir.getFileHandle('closed.runme', { create: true })
      async function write(content: string) {
        const writer = await file.createWritable()
        await writer.write(content)
        await writer.close()
      }
      await write(original)
      const [mount] = await appState.filesystemStore.listWorkspaces()
      const uri = await appState.localNotebooks.addFile(`fs://workspace/${mount.id}/file/closed.runme`, 'closed.runme')
      await appState.localNotebooks.load(uri)
      const log = parseOperationLog(original)
      const operation = createRunmeOperation({
        actorId: 'actor_disk', actorSequence: 1, dependencies: [], knownOperations: [],
        kind: 'notebook.update', payload: { metadata: { externalEdit: 'present' }, frontmatter: {} },
      })
      await write(serializeOperationLog(log.header, [operation]))
      if ((await appState.localNotebooks.loadContent(uri)).includes('externalEdit')) {
        throw new Error('The initial mirror already contains the external change.')
      }
      return uri as string
    }, { folderName, original })
    const started = Date.now()
    let imported = false
    while (!imported && Date.now() - started < 270_000) {
      imported = await page.evaluate(async (uri) => {
        const runtimePath = '/src/lib/runtime/AppState.ts'
        const { appState } = await import(runtimePath)
        return (await appState.localNotebooks.loadContent(uri)).includes('externalEdit')
      }, mirror)
      if (!imported) await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    assert.ok(imported, 'The owner should pull a disk-only change without an editor or explicit sync')
    console.log(`Closed notebook reconciled after ${Math.round((Date.now() - started) / 1000)} seconds.`)
    console.log('Verified mount, download, reopen, and disk-only reconciliation for a closed notebook.')
  } finally {
    await browser.close()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
