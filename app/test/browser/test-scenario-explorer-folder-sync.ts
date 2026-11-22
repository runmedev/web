import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = process.env.CUJ_FRONTEND_URL ?? 'http://localhost:5173'
const base = dirname(fileURLToPath(import.meta.url)).replace(/[/\\]\.generated$/, '')
const output = join(base, 'test-output')
const session = process.env.AGENT_BROWSER_SESSION ?? `explorer-sync-${Date.now()}`
const evidence: Record<string, unknown> = {}
mkdirSync(output, { recursive: true })

/** Run this CUJ in its own browser session using real browser storage. */
function browser(...args: string[]): string {
  return execFileSync('agent-browser', ['--session', session, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim()
}

/** Invoke production modules and inspect actual rendered controls. */
function evaluate<T = unknown>(code: string): T {
  return JSON.parse(browser('eval', `(async () => { ${code} })()`))
}

/** Poll for a UI result; the periodic-refresh check uses the real one-minute timer. */
function waitFor(code: string, description: string, attempts = 60): void {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (evaluate(code)) return
    browser('wait', '500')
  }
  throw new Error(`Timed out: ${description}`)
}

/** Keep failures tied to the specific UI contract being checked. */
function assert(condition: unknown, description: string): void {
  if (!condition) throw new Error(description)
  console.log(`[PASS] ${description}`)
}

let recording = false
try {
  browser('open', frontend)
  browser('record', 'start', join(output, 'scenario-explorer-folder-sync-walkthrough.webm'))
  recording = true
  waitFor('return Boolean(window.app?.localNotebooks);', 'storage initialization')
  evaluate(`
    const toggle = document.querySelector('button[aria-label="Toggle Explorer panel"]');
    if (toggle?.getAttribute('aria-pressed') !== 'true') toggle?.click();
    return true;
  `)
  waitFor('return Boolean(document.querySelector("button[aria-label=\\"Sync folders\\"]"));', 'sync button')
  const rootUri = evaluate<string>(`
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Explorer sync', {create:true});
    const folder = await window.app.localNotebooks.mountFilesystemFolder(dir);
    await window.app.localNotebooks.create(folder, 'sync-original.runme');
    window.app.addWorkspaceItem(folder);
    return folder;
  `)
  const rootSelector = JSON.stringify('[data-node-id="' + rootUri + '"]')
  waitFor(`return Boolean(document.querySelector(${rootSelector}));`, 'mounted root')
  evaluate(`document.querySelector(${rootSelector})?.querySelector('button[aria-label="Expand folder"]')?.click(); return true;`)
  waitFor('return document.querySelector("#workspace-explorer-box")?.textContent.includes("sync-original.runme");', 'initial listing')

  // Change the upstream listing outside the app so only a refresh can see it.
  const addDiskFile = (name: string) => evaluate(`
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Explorer sync');
    const bytes = await (await dir.getFileHandle('sync-original.runme')).getFile();
    const writer = await (await dir.getFileHandle(${JSON.stringify(name)}, {create:true})).createWritable();
    await writer.write(bytes);
    await writer.close();
    return true;
  `)
  addDiskFile('sync-timer.runme')
  waitFor('return document.querySelector("#workspace-explorer-box")?.textContent.includes("sync-timer.runme");', 'automatic folder refresh', 150)
  assert(true, 'The one-minute timer discovers a new disk file without a click')

  const layout = evaluate<{ width: number; height: number; beforeOpen: boolean }>(`
    const sync = document.querySelector('button[aria-label="Sync folders"]').getBoundingClientRect();
    const open = document.querySelector('button[aria-label="Open local folder"]')?.getBoundingClientRect();
    return { width: sync.width, height: sync.height, beforeOpen: !open || sync.right <= open.left };
  `)
  evidence.desktop = layout
  assert(layout.width >= 44 && layout.height >= 44 && layout.beforeOpen, 'Sync has a 44px target immediately before Open local folder')
  browser('screenshot', join(output, 'scenario-explorer-folder-sync-desktop.png'))

  browser('set', 'viewport', '390', '844')
  addDiskFile('sync-mobile.runme')
  browser('find', 'role', 'button', 'click', '--name', 'Sync folders', '--exact')
  waitFor('return document.querySelector("#workspace-explorer-box")?.textContent.includes("sync-mobile.runme");', 'phone toolbar refresh')
  assert(true, 'A phone-width toolbar click refreshes the listing without a context menu')
  const result = evaluate<{ refreshed: string[]; failed: string[] }>(`
    const { explorerSync } = await import('/src/lib/explorerSync.ts');
    return await explorerSync.sync();
  `)
  evidence.sync = result
  assert(result.failed.length === 0 && result.refreshed.includes(rootUri), 'The shared runtime reports a successful folder refresh')
  browser('screenshot', join(output, 'scenario-explorer-folder-sync-mobile.png'))
} catch (error) {
  console.log(`[FAIL] ${String(error)}`)
  try {
    browser('screenshot', join(output, 'scenario-explorer-folder-sync-failure.png'))
  } catch {
    // Preserve the original assertion failure if the browser already exited.
  }
  throw error
} finally {
  writeFileSync(join(output, 'scenario-explorer-folder-sync-evidence.json'), JSON.stringify(evidence, null, 2))
  try {
    if (recording) browser('record', 'stop')
  } finally {
    browser('close')
  }
}
