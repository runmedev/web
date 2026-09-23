import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Page, chromium } from 'playwright-core'

/** Exercise real SharedWorker, MessagePorts, IndexedDB and OPFS in an isolated profile. */
async function connect(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/test/fixtures/storage-owner.html`)
  await page.evaluate(async () => {
    // Vite serves these repository modules; no user browser/profile is touched.
    const { createSharedNotebookStore } = await import(
      /* @vite-ignore */ String('/src/storage/storageOwnerClient.ts')
    )
    const { DriveNotebookStore } = await import(
      /* @vite-ignore */ String('/src/storage/drive.ts')
    )
    ;(window as any).store = createSharedNotebookStore(
      new DriveNotebookStore(async () => {
        // Intentionally stall credential delivery when the test starts a sync.
        // No real Drive request or production credentials are used.
        return new Promise<string>(() => {})
      })
    )
  })
}
async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'runme-storage-owner-'))
  const executablePath = process.env.CHROMIUM_PATH
  const baseUrl = process.env.RUNME_TEST_URL ?? 'http://127.0.0.1:5193'
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      executablePath,
      headless: true,
      args: ['--no-sandbox'],
    })
  let context = await launch()
  const errors: string[] = []
  context.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text())
  })
  context.on('page', (page) =>
    page.on('pageerror', (error) => errors.push(error.message))
  )
  try {
    const a = await context.newPage(),
      b = await context.newPage()
    await Promise.all([connect(a, baseUrl), connect(b, baseUrl)])
    const uri = await a.evaluate(
      async () =>
        (
          await (window as any).store.create(
            'local://folder/local',
            'shared-owner-smoke.runme'
          )
        ).uri
    )
    await Promise.all(
      [a, b].map((page) =>
        page.evaluate(async (uri) => {
          const store = (window as any).store
          ;(window as any).view = await store.createOperationLogSaveStore(uri)
          ;(window as any).notebook = await store.loadOperationLogSnapshot(uri)
        }, uri)
      )
    )
    await Promise.all(
      [a, b].map((page, index) =>
        page.evaluate(
          async ({ uri, index }) => {
            const { create } = await import(
              /* @vite-ignore */ String('/.vite/deps/@bufbuild_protobuf.js')
            )
            const { parser_pb } = await import(
              /* @vite-ignore */ String('/src/runme/client.ts')
            )
            const notebook = (window as any).notebook
            notebook.cells.push(
              create(parser_pb.CellSchema, {
                refId: `tab-${index}`,
                kind: 1,
                languageId: 'markdown',
                value: `From tab ${index}`,
              })
            )
            await (window as any).view.save(uri, notebook)
          },
          { uri, index }
        )
      )
    )
    const result = await a.evaluate(async (uri) => {
      const store = (window as any).store
      const notebook = await store.loadOperationLogSnapshot(uri)
      const file = await store.files.get(uri)
      return {
        cells: notebook.cells.map((c: any) => c.value).sort(),
        checksum: file.md5Checksum,
        content: await store.loadContent(uri),
      }
    }, uri)
    if (
      JSON.stringify(result.cells) !==
      JSON.stringify(['From tab 0', 'From tab 1'])
    )
      throw new Error('Concurrent edits did not converge')
    if (result.checksum !== '')
      throw new Error('Local save eagerly published checksum')
    // Make a real worker sync stall before network I/O, then prove that cached
    // opens and newly created pending notebooks still work through MessagePorts.
    await a.evaluate(async (uri) => {
      const store = (window as any).store
      await store.files.update(uri, {
        remoteId:
          'https://drive.google.com/file/d/storage-owner-test-blocked/view',
        lastSynced: '',
      })
      store.setDriveSyncAvailable(true)
      void store.sync(uri).catch(() => {})
    }, uri)
    await a.waitForFunction(
      async (uri) =>
        (await (window as any).store.getSyncState(uri)).status === 'syncing',
      uri
    )
    const offline = await b.evaluate(async (uri) => {
      const store = (window as any).store
      // Fail quickly instead of waiting for the five-minute RPC timeout.
      const withinDeadline = <T>(operation: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout>
        return Promise.race([
          operation,
          new Promise<T>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Local open waited for upstream work')),
              2000
            )
          }),
        ]).finally(() => clearTimeout(timer))
      }
      const cached = await withinDeadline<any>(store.load(uri))
      // Turning auth off must not wait for the already running sync either.
      store.setDriveSyncAvailable(false)
      await store.folders.put({
        id: 'local://folder/offline-test',
        name: 'Offline test',
        remoteId: 'https://drive.google.com/drive/folders/storage-owner-test',
        children: [],
        lastSynced: '',
      })
      const created = await withinDeadline<any>(
        store.create('local://folder/offline-test', 'offline.runme')
      )
      const notebook = await withinDeadline<any>(store.load(created.uri))
      const view = await store.createOperationLogSaveStore(created.uri)
      notebook.cells.push({
        ...cached.cells[0],
        refId: 'offline-cell',
        value: 'Saved before upstream creation',
      })
      await view.save(created.uri, notebook)
      const reopened = await withinDeadline<any>(store.load(created.uri))
      return {
        cached: cached.cells.map((cell: any) => cell.value).sort(),
        value: reopened.cells[0].value,
        state: (await store.getSyncState(created.uri)).status,
      }
    }, uri)
    if (
      JSON.stringify(offline.cached) !== JSON.stringify(result.cells) ||
      offline.value !== 'Saved before upstream creation' ||
      offline.state !== 'pending-upstream-create'
    )
      throw new Error(
        'Offline open/create/edit/reopen did not preserve local content'
      )
    await context.close()
    context = await launch()
    const restored = await context.newPage()
    await connect(restored, baseUrl)
    const recovered = await restored.evaluate(async (uri) => {
      const store = (window as any).store
      const notebook = await store.loadOperationLogSnapshot(uri)
      return {
        cells: notebook.cells.map((c: any) => c.value).sort(),
        content: await store.loadContent(uri),
      }
    }, uri)
    if (recovered.content !== result.content)
      throw new Error('OPFS bytes changed across browser restart')
    if (errors.length) throw new Error(errors.join('\n'))
    await mkdir('test/browser/test-output', { recursive: true })
    await writeFile(
      'test/browser/test-output/storage-owner.json',
      JSON.stringify(
        {
          passed: true,
          checks: [
            'real SharedWorker + two MessagePorts',
            'concurrent causal edits preserved',
            'checksum remains unset',
            'cached open bypasses stalled worker reconciliation',
            'offline Drive-folder create/edit/reopen before upstream creation',
            'browser restart restores exact OPFS bytes',
          ],
          cells: recovered.cells,
        },
        null,
        2
      )
    )
    console.log(
      'PASS: SharedWorker two-tab edits, pending checksums and restart persistence'
    )
  } finally {
    await context.close()
    await rm(profile, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
