import type { Page } from 'playwright-core'

/** Give browser tests a writable notebook destination in their isolated profile.
 * Frozen release fixtures retain the creation API of their original version.
 */
export async function notebookDestination(page: Page): Promise<{ folderUri?: string }> {
  return page.evaluate(async () => {
    const w = window as any
    if (w.runmeRelease?.active?.manifest.owner.rpcMax < 9) return {}
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(
      'Test notebooks', { create: true }
    )
    return { folderUri: await w.app.localNotebooks.mountFilesystemFolder(directory) }
  })
}
