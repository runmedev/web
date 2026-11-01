import React from 'react'
import { createRoot } from 'react-dom/client'
import { create } from '@bufbuild/protobuf'
import '../../src/index.css'
import StorageWorkerLogs from '../../src/components/Logs/StorageWorkerLogs'
import { storageWorkerTools } from '../../src/lib/runtime/storageWorkerTools'
import type { ModelContextLike } from '../../src/lib/runtime/desktopTools'
import { OWNER_LOCK } from '../../src/releases/control'
import { parser_pb } from '../../src/runme/client'
import { StorageOwnerClient } from '../../src/storage/storageOwnerClient'
import {
  getStorageWorkerStatus,
  listStorageWorkers,
  readStorageWorkerLogs,
  restartStorageWorker,
} from '../../src/storage/workerDiagnostics'

const output = document.getElementById('results')!
const start = document.getElementById('start') as HTMLButtonElement
const release = document.getElementById('release') as HTMLButtonElement
const panel = createRoot(document.getElementById('diagnostics-ui')!)
const evidence: Array<{ name: string; detail?: unknown }> = []
const owned = new Set<string>()
const ports: MessagePort[] = []
const clients: StorageOwnerClient[] = []
const tools = storageWorkerTools()
const context =
  (document as Document & { modelContext?: ModelContextLike }).modelContext ??
  (navigator as Navigator & { modelContext?: ModelContextLike }).modelContext
for (const tool of tools) void context?.registerTool(tool)

/** Keep assertions and evidence visible, and exportable by browser/CI tooling. */
function check(ok: unknown, name: string, detail?: unknown): asserts ok {
  if (!ok) throw new Error(name)
  evidence.push({ name, detail })
  output.textContent = JSON.stringify({ state: 'running', evidence }, null, 2)
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Poll actual protocol replies, with a deadline rather than guessed readiness. */
async function until<T>(
  read: () => Promise<T | undefined>,
  label: string
): Promise<T> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await delay(50)
  }
  throw new Error(`Timed out: ${label}`)
}
/** Start a real independently named worker and bind its early control identity. */
async function spawn() {
  const worker = new SharedWorker(
    new URL('../../src/storage/storageOwner.worker.ts', import.meta.url),
    { type: 'module', name: `observability-${crypto.randomUUID()}` }
  )
  worker.port.start()
  ports.push(worker.port)
  const status = await until(
    async () =>
      (await listStorageWorkers({ timeoutMs: 100 })).workers.find(
        (w) => !owned.has(w.instanceId)
      ),
    'worker discovery'
  )
  owned.add(status.instanceId)
  return { worker, instanceId: status.instanceId }
}
/** Connect only after initialization; diagnostics themselves never need this RPC. */
async function connect(worker: SharedWorker) {
  const client = new StorageOwnerClient(worker.port, async () => {
    throw new Error('Test must not request Drive credentials')
  })
  clients.push(client)
  await client.request('handshake')
  await client.request('hello', [{ credentialBoundary: 'default' }])
  return client
}
async function ready(instanceId: string) {
  return until(async () => {
    const s = await getStorageWorkerStatus({ instanceId, timeoutMs: 500 })
    return s.phase === 'ready' ? s : undefined
  }, 'worker ready')
}
async function stop(instanceId: string, force = false) {
  const r = await restartStorageWorker({
    instanceId,
    mode: force ? 'force' : 'graceful',
    timeoutMs: 3000,
  })
  check(r.outcome === 'stopped', 'Targeted cooperative stop acknowledged', {
    force,
    instanceId,
  })
}
/** Exercise real locks/transactions and OPFS, without a fake storage backend. */
async function run() {
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) ||
    !new URL(location.href).searchParams.has('isolated')
  )
    throw new Error('Use a dedicated loopback port and ?isolated=1')
  check(
    (await listStorageWorkers({ timeoutMs: 150 })).workers.length === 0,
    'No unrelated worker on the fixture origin'
  )
  let unlock!: () => void, acquired!: () => void
  const acquiredPromise = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const lock = navigator.locks.request(OWNER_LOCK, async () => {
    acquired()
    await new Promise<void>((resolve) => {
      unlock = resolve
    })
  })
  await acquiredPromise
  try {
    const a = await spawn(),
      b = await spawn()
    for (const w of [a, b]) {
      const status = JSON.parse(
        await tools
          .find((t) => t.name === 'GetStorageWorkerStatus')!
          .execute({ instanceId: w.instanceId })
      )
      const page = JSON.parse(
        await tools
          .find((t) => t.name === 'ReadStorageWorkerLogs')!
          .execute({ instanceId: w.instanceId, timeoutMs: 500 })
      )
      check(
        status.phase === 'waiting-for-lock' &&
          page.events.some((e: any) => e.attrs.phase === 'waiting-for-lock'),
        'Direct tools answer before owner-lock acquisition',
        { instanceId: w.instanceId }
      )
    }
    const blocked = await restartStorageWorker({
      instanceId: a.instanceId,
      timeoutMs: 100,
    })
    check(
      blocked.outcome === 'unknown' && !blocked.force,
      'Graceful timeout never forces termination'
    )
    await stop(a.instanceId, true)
    check(
      (await getStorageWorkerStatus({ instanceId: b.instanceId })).phase ===
        'waiting-for-lock',
      'Stopping one candidate leaves the other intact'
    )
    await stop(b.instanceId, true)
  } finally {
    unlock()
    await lock
  }

  const warm = await spawn()
  await ready(warm.instanceId)
  const client = await connect(warm.worker)
  const item = (await client.request('create', [
    'local://folder/local',
    `diagnostics-preservation-${crypto.randomUUID()}.runme`,
  ])) as { uri: string }
  const view = (await client.request('createView', [item.uri])) as {
    id: string
    initialNotebook: parser_pb.Notebook
  }
  view.initialNotebook.cells.push(
    create(parser_pb.CellSchema, {
      refId: 'preserved-cell',
      kind: 1,
      languageId: 'markdown',
      value: 'original notebook content',
    })
  )
  await client.request('saveView', [view.id, item.uri, view.initialNotebook])
  const original = await client.request('loadContent', [item.uri])
  client.close()
  await stop(warm.instanceId)
  const historical = await readStorageWorkerLogs({
    instanceId: warm.instanceId,
    timeoutMs: 300,
  })
  check(
    historical.events.length > 0 &&
      historical.sources.memory.state === 'unavailable' &&
      historical.sources.opfs.state === 'available',
    'Committed logs remain readable after worker exit'
  )

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('runme-local-notebooks')
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  const tx = db.transaction('folders', 'readwrite')
  let keep = true
  const pump = () => {
    if (keep) {
      const r = tx.objectStore('folders').get('__diagnostics_test_hold__')
      r.onsuccess = pump
      r.onerror = () => {}
    }
  }
  pump()
  let releaseHold!: () => void
  const held = new Promise<void>((resolve) => {
    releaseHold = resolve
  })
  const watchdog = setTimeout(() => {
    keep = false
    try {
      tx.abort()
    } catch {}
    releaseHold()
  }, 45000)
  release.onclick = () => {
    keep = false
    try {
      tx.abort()
    } catch {}
    releaseHold()
  }
  const blocked = await spawn()
  try {
    await until(async () => {
      const s = await getStorageWorkerStatus({ instanceId: blocked.instanceId })
      return s.phase === 'initializing-storage' ? s : undefined
    }, 'blocked initialization')
    await delay(5100)
    const page = JSON.parse(
      await tools
        .find((t) => t.name === 'ReadStorageWorkerLogs')!
        .execute({ instanceId: blocked.instanceId, timeoutMs: 500 })
    )
    check(
      page.events.some(
        (e: any) =>
          e.attrs.operation === 'ensure-folder-read' &&
          e.attrs.state === 'waiting'
      ),
      'Real IndexedDB writer blocks startup read while direct tools respond',
      { instanceId: blocked.instanceId }
    )
    panel.render(<StorageWorkerLogs key={blocked.instanceId} />)
    release.disabled = false
    output.textContent = JSON.stringify(
      {
        state: 'IndexedDB deliberately blocked; inspect tools/UI, then release',
        instanceId: blocked.instanceId,
        evidence,
      },
      null,
      2
    )
    await held
  } finally {
    clearTimeout(watchdog)
    keep = false
    try {
      tx.abort()
    } catch {}
    db.close()
    release.disabled = true
  }
  const status = await ready(blocked.instanceId)
  check(
    status.instanceId === status.diagnostics?.instanceId,
    'Bootstrap and runtime use one worker identity'
  )
  const reopened = await connect(blocked.worker)
  check(
    (await reopened.request('loadContent', [item.uri])) === original,
    'Diagnostics and blocked reads preserved original notebook bytes'
  )
  const edit = (await reopened.request('createView', [item.uri])) as {
    id: string
    initialNotebook: parser_pb.Notebook
  }
  edit.initialNotebook.cells[0].value = 'edited after recovery'
  await reopened.request('saveView', [edit.id, item.uri, edit.initialNotebook])
  const saved = (await reopened.request('loadOperationLogSnapshot', [
    item.uri,
  ])) as parser_pb.Notebook
  check(
    saved.cells[0].value === 'edited after recovery',
    'Recovered notebook remains editable and reopenable'
  )

  panel.render(null)
  const storage = navigator.storage
  const descriptor = Object.getOwnPropertyDescriptor(storage, 'getDirectory')
  const originalGet = storage.getDirectory.bind(storage)
  const pending: Array<(root: FileSystemDirectoryHandle) => void> = []
  try {
    Object.defineProperty(storage, 'getDirectory', {
      configurable: true,
      value: () =>
        new Promise<FileSystemDirectoryHandle>((resolve) =>
          pending.push(resolve)
        ),
    })
    for (let n = 0; n < 3; n++) {
      const p = await readStorageWorkerLogs({
        instanceId: blocked.instanceId,
        timeoutMs: 100,
      })
      check(
        p.sources.memory.state === 'available' &&
          p.sources.opfs.state === 'unavailable',
        'Stalled OPFS reader returns bounded live evidence'
      )
    }
    check(pending.length === 2, 'Timed-out native reads retain bounded slots')
  } finally {
    if (descriptor) Object.defineProperty(storage, 'getDirectory', descriptor)
    else delete (storage as any).getDirectory
    const root = await originalGet()
    pending.forEach((resolve) => resolve(root))
    await delay(10)
  }
  check(
    (await readStorageWorkerLogs({ instanceId: blocked.instanceId })).sources
      .opfs.state === 'available',
    'Late native reads release slots and disk reads recover'
  )
  const final = (await reopened.request('loadOperationLogSnapshot', [
    item.uri,
  ])) as parser_pb.Notebook
  check(
    final.cells[0].value === 'edited after recovery',
    'OPFS diagnostic failures did not affect notebook contents'
  )
  reopened.close()
  await stop(blocked.instanceId)
  panel.render(<StorageWorkerLogs key="historical" />)
  output.textContent = JSON.stringify({ state: 'PASS', evidence }, null, 2)
}
start.onclick = () => {
  start.disabled = true
  void run()
    .catch((error) => {
      output.textContent = JSON.stringify(
        { state: 'FAIL', error: String(error), evidence },
        null,
        2
      )
    })
    .finally(() => {
      clients.forEach((c) => c.close())
      ports.forEach((p) => p.close())
    })
}
