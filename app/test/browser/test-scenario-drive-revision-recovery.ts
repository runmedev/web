import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// This browser integration scenario exercises real IndexedDB, OPFS and Web
// Locks through production storage modules served by Vite. The Go fake owns
// the deterministic network race; no backend is implemented in this driver.
const frontend = process.env.CUJ_FRONTEND_URL ?? 'http://localhost:5173'
const fakeDrive = process.env.CUJ_FAKE_DRIVE_URL ?? 'http://127.0.0.1:9090'
const base = dirname(fileURLToPath(import.meta.url)).replace(
  /[/\\]\.generated$/,
  ''
)
const output = join(base, 'test-output')
const runId = `recovery-${Date.now()}`
const sessions = [`${runId}-a`, `${runId}-b`]
mkdirSync(output, { recursive: true })

/** Execute the same public storage code in each isolated browser profile. */
function browser(session: string, ...args: string[]): string {
  return execFileSync('agent-browser', ['--session', session, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  }).trim()
}
function evaluate(session: string, code: string): any {
  return JSON.parse(browser(session, 'eval', `(async () => { ${code} })()`))
}
const setup = `
  const { default: LocalNotebooks } = await import('/src/storage/local.ts');
  const { DriveNotebookStore } = await import('/src/storage/drive.ts');
  const { setGoogleDriveBaseUrl } = await import('/src/lib/googleDriveRuntime.ts');
  const { createDefaultOperationLogStorage } = await import('/src/storage/operationLogs.ts');
  const log = await import('/src/lib/operationLog/index.ts');
  setGoogleDriveBaseUrl(${JSON.stringify(fakeDrive)});
  window.recoveryRequests = [];
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    window.recoveryRequests.push({ url: String(input), method: init?.method, ifMatch: new Headers(init?.headers).get('If-Match') });
    return originalFetch(input, init);
  };
  const drive = new DriveNotebookStore(async () => 'fake-access-token');
  const ops = createDefaultOperationLogStorage();
  const db = new LocalNotebooks(drive, ${JSON.stringify(runId)}, undefined, undefined, undefined, undefined, ops);
  window.recovery = { drive, ops, db, log };
`
const assertions: Record<string, unknown> = {}
try {
  for (const session of sessions) {
    browser(session, 'open', frontend)
    evaluate(session, setup + `return true;`)
  }
  const fixture = evaluate(
    sessions[0]!,
    `
    const { drive, log } = window.recovery;
    const header = { record_type: 'runme.notebook', format_version: 1, notebook_id: '${runId}', created_by: 'actor_seed', created_at: '2026-09-05T00:00:00Z' };
    const make = actor => log.createRunmeOperation({ actorId: actor, actorSequence: 1, dependencies: [], knownOperations: [], kind: 'notebook.update', payload: { frontmatter: { [actor]: 'true' }, metadata: {} } });
    const alice = make('actor_alice'), bob = make('actor_bob');
    const empty = log.serializeOperationLog(header, []);
    const item = await drive.createContent('https://drive.google.com/drive/folders/shared-folder-123', '${runId}.runme', empty, 'application/vnd.runme.notebook+jsonl');
    return { remoteUri: item.uri, alice: log.serializeOperationLog(header, [alice]), bob: log.serializeOperationLog(header, [bob]), expected: [alice.op_id, bob.op_id].sort() };
  `
  )
  for (let index = 0; index < sessions.length; index++) {
    evaluate(
      sessions[index]!,
      `
      const { db, ops } = window.recovery;
      const localUri = 'local://file/${runId}';
      const stored = await ops.initialize(localUri, ${JSON.stringify(index === 0 ? fixture.alice : fixture.bob)});
      await db.files.put({ id: localUri, name: '${runId}.runme', remoteId: ${JSON.stringify(fixture.remoteUri)}, lastRemoteChecksum: '', lastSynced: '', doc: '', md5Checksum: stored.checksum, operationLogRef: stored.ref });
      return true;
    `
    )
  }
  // The Go service writes B after A's preflight and before applying A's PATCH.
  // Therefore A sees its own checksum at head while B exists only in history.
  evaluate(
    sessions[0]!,
    `
    const fileId = ${JSON.stringify(fixture.remoteUri)}.split('/d/')[1].split('/')[0];
    const armed = await fetch(${JSON.stringify(fakeDrive + '/__test/intervening-write')}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, content: ${JSON.stringify(fixture.bob)} }) });
    if (!armed.ok) throw new Error('Failed to arm the intervening write');
    await window.recovery.db.reconcileDriveNotebook('local://file/${runId}');
    return true;
  `
  )
  for (const session of sessions) {
    assertions[session] = evaluate(
      session,
      `
      const { db, drive, log } = window.recovery;
      await db.reconcileDriveNotebook('local://file/${runId}');
      const ids = text => log.parseOperationLog(text).operations.map(op => op.op_id).sort();
      const local = ids(await db.loadContent('local://file/${runId}'));
      const remote = ids(await drive.loadContent(${JSON.stringify(fixture.remoteUri)}));
      const expected = ${JSON.stringify(fixture.expected)};
      if (JSON.stringify(local) !== JSON.stringify(expected) || JSON.stringify(remote) !== JSON.stringify(expected)) throw new Error('Operations did not converge');
      const requests = window.recoveryRequests;
      if (requests.some(r => r.url.includes('/drive/v2/') || r.ifMatch)) throw new Error('Unexpected v2 or If-Match dependency');
      return { local, remote, requests, checkpoint: (await db.files.get('local://file/${runId}')).driveRecoveryCheckpoint };
    `
    )
    browser(session, 'reload')
    evaluate(
      session,
      setup +
        `
      const ids = log.parseOperationLog(await db.loadContent('local://file/${runId}')).operations.map(op => op.op_id).sort();
      if (JSON.stringify(ids) !== ${JSON.stringify(JSON.stringify(fixture.expected))}) throw new Error('Reload lost operations');
      return true;
    `
    )
  }
  const first = assertions[sessions[0]!] as {
    requests: { url: string; method: string }[]
  }
  if (
    !first.requests.some(
      (r) => r.url.includes('/revisions/') && r.method === 'PATCH'
    )
  )
    throw new Error('Scenario never retained a historical revision')
  writeFileSync(
    join(output, 'scenario-drive-revision-recovery-assertions.json'),
    JSON.stringify({ passed: true, assertions }, null, 2)
  )
  console.log(
    '[PASS] Two isolated browser journals converged after an overwritten revision and retained operations across reload; v3 only.'
  )
} catch (error) {
  writeFileSync(
    join(output, 'scenario-drive-revision-recovery-assertions.json'),
    JSON.stringify({ passed: false, error: String(error), assertions }, null, 2)
  )
  throw error
} finally {
  for (const session of sessions) {
    try {
      browser(session, 'close')
    } catch {
      /* Keep the original assertion failure. */
    }
  }
}
