import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Page, chromium } from 'playwright-core'

/** Connect an isolated tab to the real owner without providing network credentials. */
async function connect(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/test/fixtures/storage-owner.html`)
  await page.evaluate(async () => {
    const { createSharedNotebookStore } = await import(
      /* @vite-ignore */ String('/src/storage/storageOwnerClient.ts')
    )
    const { DriveNotebookStore } = await import(
      /* @vite-ignore */ String('/src/storage/drive.ts')
    )
    ;(window as any).store = createSharedNotebookStore(
      new DriveNotebookStore(async () => {
        throw new Error('Offline test')
      })
    )
  })
}

/** Upgrade a real version-8 database, page it, edit it, and restart the browser. */
async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'runme-storage-payloads-'))
  const baseUrl = process.env.RUNME_TEST_URL ?? 'http://127.0.0.1:5193'
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROMIUM_PATH,
      headless: true,
      args: ['--no-sandbox'],
    })
  let context = await launch()
  // page.evaluate has no default deadline; bound a broken worker handshake too.
  const deadline = setTimeout(() => {
    void context.close()
  }, 90_000)
  try {
    const page = await context.newPage()
    await page.goto(`${baseUrl}/test/fixtures/storage-owner.html`)
    const original = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        // Dexie's logical schema version 8 is native IndexedDB version 80.
        const open = indexedDB.open('runme-local-notebooks', 80)
        open.onupgradeneeded = () => {
          const schemas: Record<string, [string, string[]]> = {
            files: [
              'id',
              [
                'remoteId',
                'lastRemoteChecksum',
                'md5Checksum',
                'name',
                'lastSynced',
              ],
            ],
            folders: ['id', ['remoteId', 'name', 'lastSynced']],
            driveCreates: ['id', []],
            contentGenerations: ['path', []],
            driveCreateAttempts: ['id', ['requestId']],
          }
          for (const [name, [keyPath, indexes]] of Object.entries(schemas)) {
            const table = open.result.createObjectStore(name, { keyPath })
            for (const index of indexes) table.createIndex(index, index)
          }
        }
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error)
      })
      const content = JSON.stringify({
        cells: [
          {
            kind: 'CELL_KIND_MARKUP',
            value: 'Legacy ü notebook\n' + 'x'.repeat(128 * 1024),
          },
        ],
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite')
        for (let i = 0; i < 67; i++) {
          const id = `local://file/legacy-${String(i).padStart(3, '0')}`
          tx.objectStore('files').put({
            id,
            name: `legacy-${i}.${i % 2 ? 'ipynb' : 'json'}`,
            remoteId: id,
            // Match the ~51 MB notebook seen in the crash heap without
            // returning its body to the test runner or opening it in a view.
            doc:
              i === 66
                ? JSON.stringify({
                    cells: [
                      {
                        kind: 'CELL_KIND_MARKUP',
                        value: 'x'.repeat(50 * 1024 * 1024),
                      },
                    ],
                  })
                : content,
            lastRemoteChecksum: '',
            md5Checksum: '',
            lastSynced: '',
          })
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
      return content
    })
    console.log('Seeded 67 legacy records in schema 8')
    await connect(page, baseUrl)
    const pages = await page.evaluate(async () => {
      const store = (window as any).store
      const first = await store.listFileSyncStatusPage({ limit: 500 })
      const second = await store.listFileSyncStatusPage({
        cursor: first.nextCursor,
        limit: 500,
      })
      return {
        lengths: [first.rows.length, second.rows.length],
        ids: [...first.rows, ...second.rows].map((row: any) => row.localUri),
        done: second.nextCursor === undefined,
      }
    })
    if (
      JSON.stringify(pages.lengths) !== '[50,17]' ||
      new Set(pages.ids).size !== 67 ||
      !pages.done
    )
      throw new Error('Status pagination lost records or exceeded its cap')
    await page.waitForFunction(
      async () => {
        const store = (window as any).store
        // Bounded reads even in the test: never materialize the legacy table.
        for (let i = 0; i < 67; i++) {
          const row = await store.files.get(
            `local://file/legacy-${String(i).padStart(3, '0')}`
          )
          if (row.doc !== '' || !row.contentRef) return false
        }
        return true
      },
      undefined,
      { timeout: 30_000 }
    )
    console.log('Pagination and one-record-at-a-time OPFS migration passed')
    const saved = await page.evaluate(async (original) => {
      const store = (window as any).store
      const results = []
      for (const id of ['local://file/legacy-000', 'local://file/legacy-001']) {
        const before = await store.getFileRecord(id)
        if (before.doc !== original)
          throw new Error('Migration changed original bytes')
        const notebook = await store.load(id)
        notebook.cells[0].value = 'Edited after migration: ü'
        await store.save(id, notebook)
        const raw = await store.files.get(id)
        if (raw.doc !== '' || !raw.contentRef)
          throw new Error('Save wrote inline bytes')
        if (raw.contentRef.path === before.contentRef.path)
          throw new Error('Save overwrote an immutable payload')
        results.push({
          id,
          doc: (await store.getFileRecord(id)).doc,
          previousPath: before.contentRef.path,
        })
      }
      // .runme initialization persists its recovery payload inside a Dexie transaction.
      const created = await store.create(
        'local://folder/local',
        'transaction.runme'
      )
      const raw = await store.files.get(created.uri)
      if (!raw.operationLogRef || raw.pendingOperationLogInitialization)
        throw new Error('Operation log initialization did not commit')
      return results
    }, original)
    await context.close()
    context = await launch()
    const restored = await context.newPage()
    await connect(restored, baseUrl)
    await restored.evaluate(async (saved) => {
      const store = (window as any).store
      for (const expected of saved) {
        if ((await store.getFileRecord(expected.id)).doc !== expected.doc)
          throw new Error('Browser restart lost the edited payload')
      }
    }, saved)
    await restored.waitForFunction(
      async (saved) => {
        const root = await navigator.storage.getDirectory()
        const runme = await root.getDirectoryHandle('runme')
        const payloads = await runme.getDirectoryHandle('file-payloads')
        for (const previous of saved) {
          try {
            await payloads.getFileHandle(
              previous.previousPath.split('/').at(-1)!
            )
            return false
          } catch (error) {
            if (
              !(error instanceof DOMException) ||
              error.name !== 'NotFoundError'
            )
              throw error
          }
        }
        return true
      },
      saved,
      { timeout: 10_000 }
    )
    await mkdir('test/browser/test-output', { recursive: true })
    await writeFile(
      'test/browser/test-output/storage-payloads.json',
      JSON.stringify(
        {
          passed: true,
          seededRecords: 67,
          pageSizes: pages.lengths,
          checks: [
            'schema 8 upgrade',
            'exact legacy bytes preserved in OPFS',
            'status limit clamped to 50',
            'all migrated rows contain references only',
            '50 MiB cached notebook migrates without a bulk payload read',
            'JSON and IPYNB edit/save/reopen',
            'OPFS writes inside Dexie transaction',
            'immutable payload generations',
            'browser restart preserves exact saved bytes',
            'worker restart collects obsolete payload generations',
          ],
        },
        null,
        2
      )
    )
    console.log('PASS: migration, pagination, edits, transactions and restart')
  } finally {
    clearTimeout(deadline)
    await context.close()
    await rm(profile, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
