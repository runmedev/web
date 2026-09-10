import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = process.env.CUJ_FRONTEND_URL ?? 'http://localhost:5173'
const fakeDrive = process.env.CUJ_FAKE_DRIVE_URL ?? 'http://127.0.0.1:9090'
const base = dirname(fileURLToPath(import.meta.url)).replace(
  /[/\\]\.generated$/,
  ''
)
const output = join(base, 'test-output')
const name = `colab-recovery-${Date.now()}.runme`
const session = name.replace('.runme', '')
const evidence: Record<string, unknown> = {}
mkdirSync(output, { recursive: true })

/** Use an isolated browser profile and the canonical suite's Go Drive service. */
function browser(...args: string[]): string {
  return execFileSync('agent-browser', ['--session', session, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  }).trim()
}

/** Run production modules in the test browser; no fake backend lives in this driver. */
function evaluate(code: string): any {
  return JSON.parse(browser('eval', `(async () => { ${code} })()`))
}

/** Poll asynchronous persistence rather than assuming that a rendered view is saved. */
function waitFor(code: string, description: string): void {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (evaluate(code)) return
    browser('wait', '500')
  }
  throw new Error(`Timed out: ${description}`)
}

/** Click the real accessible control, ensuring the UI handler performs the retry. */
function clickButton(label: string): void {
  browser('find', 'role', 'button', 'click', '--name', label, '--exact')
}

let recording = false
try {
  browser('open', frontend)
  browser(
    'record',
    'start',
    join(output, 'scenario-colab-export-recovery-walkthrough.webm')
  )
  recording = true
  waitFor(
    'return Boolean(window.app?.localNotebooks);',
    'local store initialization'
  )
  const fixture = evaluate(`
    const { DriveNotebookStore } = await import('/src/storage/drive.ts');
    const { setGoogleDriveBaseUrl } = await import('/src/lib/googleDriveRuntime.ts');
    const { LOCAL_FOLDER_URI } = await import('/src/storage/local.ts');
    const { AUTO_IPYNB_KEY } = await import('/src/lib/derivedNotebook.ts');
    const { parseOperationLog, serializeOperationLog, createRunmeOperation, causalHeads } = await import('/src/lib/operationLog/index.ts');
    setGoogleDriveBaseUrl(${JSON.stringify(fakeDrive)});
    const drive = new DriveNotebookStore(async () => 'fake-drive-access-token');
    const db = window.app.localNotebooks;
    if (!await db.folders.get(LOCAL_FOLDER_URI)) await db.folders.put({ id: LOCAL_FOLDER_URI, name: 'Local', remoteId: '', children: [], lastSynced: '' });
    const file = await db.create(LOCAL_FOLDER_URI, ${JSON.stringify(name)});
    const notebook = await db.load(file.uri);
    notebook.metadata[AUTO_IPYNB_KEY] = 'true';
    const journal = await db.createOperationLogSaveStore(file.uri);
    await journal.save(file.uri, notebook);
    const log = parseOperationLog(await db.loadContent(file.uri));
    if (log.header.format_version !== 2) throw new Error('Expected a V2 fixture');
    log.operations.push(createRunmeOperation({ actorId: 'browser-fixture', actorSequence: 1, knownOperations: log.operations, dependencies: causalHeads(log.operations), kind: 'cell.create', payload: { cell_id: 'colab-recovery-cell', position: [[1, 'browser-fixture', 1]], cell: { kind: 'code', language_id: 'python', value: 'print("colab recovery")', metadata: {} } } }));
    const content = serializeOperationLog(log.header, log.operations);
    await db.saveContent(file.uri, content, 'application/vnd.runme.notebook+jsonl');
    const source = await drive.createContent('https://drive.google.com/drive/folders/shared-folder-123', file.name, content, 'application/vnd.runme.notebook+jsonl');
    const record = await db.files.get(file.uri);
    await db.files.update(file.uri, {
      remoteId: source.uri, lastRemoteChecksum: record.md5Checksum,
      ipynbExportError: 'Error: Unsupported notebook log format_version 2',
    });
    if ((await db.listDriveBackedFilesNeedingSync()).includes(file.uri)) throw new Error('Fixture source must already be saved');
    sessionStorage.setItem('runme/openNotebooks', JSON.stringify([{ uri: file.uri, name: file.name, type: 'file', children: [] }]));
    sessionStorage.setItem('runme/currentDoc', file.uri);
    localStorage.setItem('googleClientConfig', '{}');
    localStorage.setItem('runme/google-auth/drive-account', 'viewer@acme.example');
    localStorage.setItem('runme/google-auth/token', JSON.stringify({ token: 'fake-drive-access-token', expiresAt: Date.now() + 600000 }));
    return { uri: file.uri, remoteUri: source.uri, content };
  `)
  const uri = JSON.stringify(fixture.uri)
  // Reload drops the old in-memory save timers. Auth initialization must recover
  // this export even though the source checksum has no unapplied edits.
  browser('reload')
  waitFor(
    `
    const db = window.app?.localNotebooks;
    if (!db) return false;
    const state = await db.getIpynbExportState(${uri});
    return Boolean(state.uri && state.exportedAt && !state.error);
  `,
    'automatic export recovery on Drive reconnect'
  )
  const firstExport = evaluate(
    `return await window.app.localNotebooks.getIpynbExportState(${uri});`
  )
  evidence.reconnect = firstExport
  console.log(
    '[PASS] Drive reconnect exported a saved V2 notebook and cleared its persisted format-version error.'
  )

  // Fail through the real network path, then restore connectivity without a
  // reload so the properties button is solely responsible for the next retry.
  evaluate(`
    const { setGoogleDriveBaseUrl } = await import('/src/lib/googleDriveRuntime.ts');
    const db = window.app.localNotebooks;
    setGoogleDriveBaseUrl(${JSON.stringify(fakeDrive + '/unavailable')});
    try { await db.syncIpynbFile(${uri}); } catch {}
    finally { setGoogleDriveBaseUrl(${JSON.stringify(fakeDrive)}); }
    if (!(await db.getIpynbExportState(${uri})).error) throw new Error('Expected a real export failure');
    const tab = [...document.querySelectorAll('[role=tab]')].find(node => node.textContent.includes(${JSON.stringify(name)}));
    if (!tab) throw new Error('Notebook tab missing');
    const rect = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 20, clientY: rect.top + 10 }));
    return true;
  `)
  clickButton('Notebook properties')
  waitFor(
    `return [...document.querySelectorAll('button')].some(node => node.textContent === 'Retry Colab export');`,
    'retry button'
  )
  browser(
    'screenshot',
    join(output, 'scenario-colab-export-recovery-error.png')
  )
  if (
    evaluate(
      `return document.body.textContent.includes('Waiting for the next background export');`
    )
  )
    throw new Error('Error and waiting messages must not appear together')
  clickButton('Retry Colab export')
  waitFor(
    `
    const state = await window.app.localNotebooks.getIpynbExportState(${uri});
    return !state.error && state.exportedAt !== ${JSON.stringify(firstExport.exportedAt)};
  `,
    'properties retry completion'
  )
  waitFor(
    `return !document.querySelector('[role=dialog]')?.textContent.includes('could not be updated');`,
    'properties error clears'
  )
  evidence.retry = evaluate(`
    const db = window.app.localNotebooks;
    const { appState } = await import('/src/lib/runtime/AppState.ts');
    const state = await db.getIpynbExportState(${uri});
    if (state.uri !== ${JSON.stringify(firstExport.uri)}) throw new Error('Retry duplicated the derived copy');
    if (await db.loadContent(${uri}) !== ${JSON.stringify(fixture.content)}) throw new Error('Retry modified source history');
    const copy = JSON.parse(await appState.driveNotebookStore.loadContent(state.uri));
    if (copy.metadata.runme.derivedFrom.uri !== ${JSON.stringify(fixture.remoteUri)}) throw new Error('Derived source identity missing');
    if (!copy.cells.some(cell => JSON.stringify(cell.source).includes('colab recovery'))) throw new Error('Committed cell source missing from Colab copy');
    return { state, cells: copy.cells.length, sourceUnchanged: true };
  `)
  browser(
    'screenshot',
    join(output, 'scenario-colab-export-recovery-success.png')
  )
  console.log(
    '[PASS] Notebook properties retried the real export, cleared its error, reused the copy, and left source history unchanged.'
  )
  writeFileSync(
    join(output, 'scenario-colab-export-recovery-assertions.json'),
    JSON.stringify({ passed: true, evidence }, null, 2)
  )
} catch (error) {
  try {
    evidence.storage = evaluate(
      `return (await window.app.localNotebooks.files.toArray()).map(({ id, name, remoteId, ipynbExportError, ipynbExportUri, ipynbExportPendingClaim }) => ({ id, name, remoteId, ipynbExportError, ipynbExportUri, ipynbExportPendingClaim }));`
    )
  } catch {}
  writeFileSync(
    join(output, 'scenario-colab-export-recovery-assertions.json'),
    JSON.stringify({ passed: false, error: String(error), evidence }, null, 2)
  )
  try {
    browser(
      'screenshot',
      join(output, 'scenario-colab-export-recovery-failure.png')
    )
  } catch {}
  console.log(`[FAIL] ${String(error)}`)
  throw error
} finally {
  try {
    if (recording) browser('record', 'stop')
  } finally {
    browser('close')
  }
}
