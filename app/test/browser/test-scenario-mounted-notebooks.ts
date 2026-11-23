import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

/** Use an actual cloneable directory handle in an isolated Chrome profile.
 * Only the native picker is substituted. The application worker, timer,
 * IndexedDB, OPFS, and download are production entry points.
 */
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(30_000)
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
      const nested = await dir.getDirectoryHandle('team', { create: true })
      const sibling = await (await nested.getFileHandle('closed.runme', { create: true })).createWritable()
      await sibling.write(content)
      await sibling.close()
      return content
    }, { folderName, name })
    await page.getByRole('button', { name: 'Open local folder', exact: true }).click()
    const root = page.locator('[data-node-id^="local://folder/"]').filter({ hasText: folderName }).first()
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

    // Place the downloaded bytes in the mounted directory, as a user would
    // when downloading a shared notebook without a Drive OAuth client.
    await page.evaluate(async (content) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Downloads', { create: true })
      Object.defineProperty(window, 'showDirectoryPicker', { value: async () => dir, configurable: true })
      const file = await dir.getFileHandle('downloaded.runme', { create: true })
      const writer = await file.createWritable()
      await writer.write(content)
      await writer.close()
    }, bytes.toString())
    await page.getByRole('button', { name: 'Open local folder', exact: true }).click()
    const downloads = page.locator('[data-node-id^="local://folder/"]').filter({ hasText: 'Downloads' }).first()
    await downloads.getByRole('button', { name: 'Expand folder' }).click()
    await page.evaluate(async () => {
      const path = '/src/lib/runtime/AppState.ts'
      const { appState } = await import(path)
      const store = appState.localNotebooks
      const roots = await Promise.all(appState.getWorkspaceItems().map((uri: string) => store.getMetadata(uri)))
      const root = roots.find(item => item?.name === 'Downloads')
      const created = await store.create(root.uri, 'created.runme')
      if (!created.uri.startsWith('local://file/')) throw new Error('Expected a local file URI')
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Downloads')
      if (!(await (await dir.getFileHandle('created.runme')).getFile()).size) throw new Error('Expected notebook bytes on disk')
      try {
        await store.create('local://folder/local', 'orphan.runme')
      } catch (error) {
        if (String(error).includes('Choose a mounted')) return
        throw error
      }
      throw new Error('Creation without an upstream should fail')
    })
    await page.getByText('downloaded.runme', { exact: true }).dblclick()
    await page.getByRole('tab', { name: 'downloaded.runme', exact: true }).click()
    await page.getByRole('button', { name: 'Close sample.runme', exact: true }).click()

    if (process.env.CUJ_SCREENSHOT_PATH) {
      await page.screenshot({ path: process.env.CUJ_SCREENSHOT_PATH })
    }

    // A second file has a durable mirror but has never had an editor. Its only
    // wakeup after first load is the storage worker's periodic reconciliation.
    const mirror = await page.evaluate(async ({ folderName, original }) => {
      const runtimePath = '/src/lib/runtime/AppState.ts'
      const codecPath = '/src/lib/operationLog/index.ts'
      const { appState } = await import(runtimePath)
      const { parseOperationLog, createRunmeOperation, serializeOperationLog } = await import(codecPath)
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folderName)
      const file = await (await dir.getDirectoryHandle('team')).getFileHandle('closed.runme')
      async function write(content: string) {
        const writer = await file.createWritable()
        await writer.write(content)
        await writer.close()
      }
      const store = appState.localNotebooks
      const roots = await Promise.all(appState.getWorkspaceItems().map((uri: string) => store.getMetadata(uri)))
      const root = roots.find(item => item?.name === folderName)
      const children = await Promise.all(root.children.map((uri: string) => store.getMetadata(uri)))
      const team = children.find(item => item.name === 'team')
      const [uri] = team.children
      if (!uri.startsWith('local://file/')) throw new Error('Expected a local mirror of the unopened nested file')
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
    // Commit through the editor persistence API and wait for ordinary queued
    // writeback. Both this operation and the prior disk edit must survive.
    await page.evaluate(async (uri) => {
      const runtimePath = '/src/lib/runtime/AppState.ts'
      const codecPath = '/src/lib/operationLog/index.ts'
      const { appState } = await import(runtimePath)
      const { parseOperationLog, createRunmeOperation } = await import(codecPath)
      const store = appState.localNotebooks
      const log = parseOperationLog(await store.loadContent(uri))
      const op = createRunmeOperation({
        actorId: 'actor_browser', actorSequence: 1, dependencies: log.operations.map((entry: { op_id: string }) => entry.op_id),
        knownOperations: log.operations, kind: 'notebook.update',
        payload: { metadata: { browserEdit: 'present' }, frontmatter: {} },
      })
      await store.commitEditorOperations(uri, log.header.notebook_id, [op])
    }, mirror)
    await page.waitForFunction(async (folder) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder)
      const text = await (await (await (await dir.getDirectoryHandle('team')).getFileHandle('closed.runme')).getFile()).text()
      return text.includes('browserEdit') && text.includes('externalEdit')
    }, folderName, { polling: 1000, timeout: 150_000 })
    console.log('Verified download, reopen from disk, and bidirectional reconciliation.')
  } finally {
    await browser.close()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
