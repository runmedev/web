// @vitest-environment node
import { MessageChannel } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DriveCreateNotCommittedError } from './drive'
import { FilesystemEntryAlreadyExistsError } from './fs'
import type LocalNotebooks from './local'
import { StorageOwnerClient } from './storageOwnerClient'
import { StorageOwnerHost } from './storageOwnerHost'
import { SyncWorkQueue } from './syncWorkQueue'

const clients: StorageOwnerClient[] = []
const ports: MessagePort[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const client of clients.splice(0)) client.close()
  for (const port of ports.splice(0)) port.close()
})
function connect(
  host: StorageOwnerHost,
  token = async () => 'token',
  boundary = () => 'default'
) {
  const channel = new MessageChannel()
  const port = channel.port1 as unknown as MessagePort
  ports.push(port)
  host.attach(port)
  const client = new StorageOwnerClient(
    channel.port2 as unknown as MessagePort,
    token,
    boundary
  )
  clients.push(client)
  return client
}
function setup() {
  const store = {
    setDriveSyncAvailable: vi.fn(),
    reconcileDriveBackedFiles: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    sync: vi.fn(async () => {}),
    createOperationLogSaveStore: vi.fn(async () => ({
      save: vi.fn(async () => {}),
      getObservedOperationHeads: () => ['op-1'],
      initialNotebook: { cells: [{ refId: 'captured-cell' }] },
    })),
  }
  return {
    store,
    host: new StorageOwnerHost(store as unknown as LocalNotebooks),
  }
}

describe('SharedWorker message boundary', () => {
  it('uses the bootstrap identity in runtime diagnostics', () => {
    const { store } = setup()
    const host = new StorageOwnerHost(
      store as unknown as LocalNotebooks,
      undefined,
      undefined,
      undefined,
      'bootstrap-worker'
    )
    expect(host.diagnostics().instanceId).toBe('bootstrap-worker')
  })

  it('negotiates across RPC versions without authorization or storage effects', async () => {
    const { store } = setup()
    const authorize = vi.fn(async () => {
      throw new Error('must not authorize negotiation')
    })
    const host = new StorageOwnerHost(
      store as unknown as LocalNotebooks,
      undefined,
      authorize
    )
    const channel = new MessageChannel()
    ports.push(
      channel.port1 as unknown as MessagePort,
      channel.port2 as unknown as MessagePort
    )
    host.attach(channel.port1 as unknown as MessagePort)
    const reply = new Promise<any>((resolve) =>
      channel.port2.once('message', resolve)
    )
    channel.port2.postMessage({
      type: 'request',
      id: 'negotiate',
      method: 'handshake',
      version: -1,
      args: [],
    })
    expect((await reply).value).toMatchObject({
      protocol: 1,
      recoveryFormat: 1,
      editorCommitVersion: 1,
    })
    expect(authorize).not.toHaveBeenCalled()
    expect(store.setDriveSyncAvailable).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
  })
  it('restores the profile boundary before unauthenticated tabs can queue writes', async () => {
    const { host, store } = setup()
    const human = connect(host)
    await expect(
      human.request('hello', [
        {
          credentialBoundary: 'default',
          profileCredentialBoundary: 'workload:test',
        },
      ])
    ).rejects.toThrow('isolated browser profile')
    await expect(human.request('save', ['a', {}])).rejects.toThrow(
      'isolated browser profile'
    )
    const workload = connect(
      host,
      async () => 'workload-token',
      () => 'workload:test'
    )
    await workload.request('hello', [
      {
        credentialBoundary: 'workload:test',
        profileCredentialBoundary: 'workload:test',
      },
    ])
    await workload.request('save', ['a', {}])
    expect(store.save).toHaveBeenCalledTimes(1)
    await workload.request('availability', [true, 'workload:test'])
    expect(await host.accessToken()).toBe('workload-token')
  })
  it('rejects workload operations on a human credential owner', async () => {
    const { host, store } = setup()
    const human = connect(host)
    const workload = connect(
      host,
      async () => 'workload-token',
      () => 'workload:test'
    )
    await human.request('availability', [true, 'default'])
    await expect(
      workload.request('availability', [true, 'workload:test'])
    ).rejects.toThrow('isolated browser profile')
    await expect(workload.request('save', ['a', {}])).rejects.toThrow(
      'isolated browser profile'
    )
    expect(store.save).not.toHaveBeenCalled()
    expect(await host.accessToken()).toBe('token')
  })
  it('coalesces same-file sync from two tabs while another file progresses', async () => {
    const { host, store } = setup()
    const q = new SyncWorkQueue({ concurrency: 10 })
    const started: string[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    store.sync.mockImplementation((...args: unknown[]) => {
      const uri = String(args[0])
      return q.run(uri, async () => {
        started.push(uri)
        if (uri === 'a') await blocked
      })
    })
    const a = connect(host),
      b = connect(host)
    const first = a.request('sync', ['a'])
    await vi.waitFor(() => expect(started).toEqual(['a']))
    const same = b.request('sync', ['a'])
    await b.request('sync', ['b'])
    expect(started).toEqual(['a', 'b'])
    release()
    await Promise.all([first, same])
    expect(started).toEqual(['a', 'b'])
    q.close()
  })

  it('shares only identical in-flight status pages across tabs', async () => {
    const { host, store } = setup()
    let resolvePage!: (value: unknown) => void
    const listFileSyncStatusPage = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePage = resolve
          })
      )
      .mockResolvedValue({ rows: [] })
    Object.assign(store, { listFileSyncStatusPage })
    const first = connect(host),
      second = connect(host)
    const options = { limit: 50 }
    const reads = [
      first.request('listFileSyncStatusPage', [options]),
      second.request('listFileSyncStatusPage', [options]),
    ]
    await Promise.all([first.request('heartbeat'), second.request('heartbeat')])
    expect(listFileSyncStatusPage).toHaveBeenCalledTimes(1)
    await second.request('listFileSyncStatusPage', [
      { limit: 50, cursor: { table: 'files', after: 'a' } },
    ])
    expect(listFileSyncStatusPage).toHaveBeenCalledTimes(2)
    resolvePage({ rows: [{ title: 'First page' }] })
    expect(await Promise.all(reads)).toEqual([
      { rows: [{ title: 'First page' }] },
      { rows: [{ title: 'First page' }] },
    ])
    await first.request('listFileSyncStatusPage', [options])
    expect(listFileSyncStatusPage).toHaveBeenCalledTimes(3)
  })

  it('shares an in-flight status scan across tabs and releases it after failure', async () => {
    const { host, store } = setup()
    let rejectScan!: (error: Error) => void
    const listFileSyncStatusPage = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectScan = reject
          })
      )
      .mockResolvedValue({ rows: [{ title: 'Recovered' }] })
    Object.assign(store, { listFileSyncStatusPage })
    const first = connect(host),
      second = connect(host)
    const requests = [
      first.request('listFileSyncStatusPage'),
      second.request('listFileSyncStatusPage'),
    ]
    const outcomes = Promise.allSettled(requests)
    // Per-port barriers ensure both reads have reached the host.
    await Promise.all([first.request('heartbeat'), second.request('heartbeat')])
    await vi.waitFor(() => expect(listFileSyncStatusPage).toHaveBeenCalled())
    expect(listFileSyncStatusPage).toHaveBeenCalledTimes(1)
    rejectScan(new Error('Read failed'))
    expect((await outcomes).map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ])
    await expect(first.request('listFileSyncStatusPage')).resolves.toEqual({
      rows: [{ title: 'Recovered' }],
    })
    expect(listFileSyncStatusPage).toHaveBeenCalledTimes(2)
  })

  it('times out diagnostics promptly without a mutation-outcome warning', async () => {
    vi.useFakeTimers()
    const channel = new MessageChannel()
    ports.push(channel.port1 as unknown as MessagePort)
    const client = new StorageOwnerClient(
      channel.port2 as unknown as MessagePort,
      async () => 'token'
    )
    clients.push(client)
    const result = expect(
      client.request('getDriveQueueMetrics')
    ).rejects.toThrow('Storage worker did not respond to queue diagnostics.')
    await vi.advanceTimersByTimeAsync(10_000)
    await result
  })

  it('serves the same queue diagnostics to both tabs through the RPC allowlist', async () => {
    const { host, store } = setup()
    const queue = new SyncWorkQueue()
    Object.assign(store, {
      getDriveQueueMetrics: async () => queue.getMetrics(),
    })
    const first = connect(host),
      second = connect(host)
    queue.add('source:pending', async () => {}, 60_000)
    try {
      const a = (await first.request('getDriveQueueMetrics')) as any
      const b = (await second.request('getDriveQueueMetrics')) as any
      expect(a).toMatchObject({ depth: 1, delayed: 1, active: 0 })
      expect(b.startedAt).toBe(a.startedAt)
      expect(b.waitHistogram).toEqual(a.waitHistogram)
    } finally {
      queue.close()
    }
  })

  it('two tabs use the same owner while local edits continue during a blocked sync', async () => {
    const { host, store } = setup()
    const first = connect(host),
      second = connect(host)
    await Promise.all([first.request('hello'), second.request('hello')])
    let release!: () => void
    store.sync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const sync = first.request('sync', ['local://file/a'])
    await vi.waitFor(() => expect(store.sync).toHaveBeenCalled())
    await second.request('save', ['local://file/a', { cells: [] }])
    expect(store.save).toHaveBeenCalledTimes(1)
    release()
    await sync
  })
  it('keeps edits available when a corrupt legacy creation journal pauses creation', async () => {
    const { host, store } = setup()
    const client = connect(host)
    await client.request('hello', [
      { creationMigrationError: 'Invalid legacy creation identity' },
    ])
    expect((store as any).driveCreationRecoveryError).toBe(
      'Invalid legacy creation identity'
    )
    await client.request('save', ['a', {}])
    expect(store.save).toHaveBeenCalledTimes(1)
  })
  it('rejects an incompatible worker protocol before performing a mutation', async () => {
    const { host, store } = setup()
    const channel = new MessageChannel()
    ports.push(
      channel.port1 as unknown as MessagePort,
      channel.port2 as unknown as MessagePort
    )
    host.attach(channel.port1 as unknown as MessagePort)
    const response = new Promise<any>((resolve) =>
      channel.port2.once('message', resolve)
    )
    channel.port2.postMessage({
      type: 'request',
      id: 'old-client',
      version: 0,
      method: 'save',
      args: ['a', {}],
    })
    expect((await response).error.message).toContain('version mismatch')
    expect(store.save).not.toHaveBeenCalled()
  })
  it('only accepts allowlisted methods and preserves failures', async () => {
    const { host, store } = setup()
    const client = connect(host)
    await expect(client.request('delete', [])).rejects.toThrow(
      'Unsupported storage operation'
    )
    store.save.mockRejectedValueOnce(new Error('OPFS quota exceeded'))
    await expect(client.request('save', ['a', {}])).rejects.toThrow(
      'OPFS quota exceeded'
    )
    expect(store.save).toHaveBeenCalledTimes(1)
  })
  it.each([
    new FilesystemEntryAlreadyExistsError('report.runme'),
    new DriveCreateNotCommittedError('Drive creation was rejected'),
  ])('preserves creation recovery error $name across RPC', async (original) => {
    const { host, store } = setup()
    const client = connect(host)
    store.save.mockRejectedValueOnce(original)
    const error = await client
      .request('save', ['a', {}])
      .catch((error) => error)
    expect(error).toBeInstanceOf(original.constructor)
    expect(error.message).toBe(original.message)
    if (original instanceof FilesystemEntryAlreadyExistsError)
      expect(error.fileName).toBe('report.runme')
  })
  it('credentials are requested from authenticated tabs without interactive login', async () => {
    const { host } = setup()
    const token = vi.fn(async () => 'ephemeral-token')
    const client = connect(host, token)
    await client.request('availability', [true])
    expect(await host.accessToken({ forceRefresh: true })).toBe(
      'ephemeral-token'
    )
    expect(token).toHaveBeenCalledWith({
      forceRefresh: true,
      interactive: false,
    })
    await client.request('availability', [false])
    await expect(host.accessToken()).rejects.toThrow(
      'authentication unavailable'
    )
  })
  it('does not reset backoff on heartbeat or a second authenticated tab', async () => {
    const { host, store } = setup()
    const first = connect(host),
      second = connect(host)
    await first.request('availability', [true])
    await vi.waitFor(() =>
      expect(store.reconcileDriveBackedFiles).toHaveBeenCalledTimes(1)
    )
    await first.request('heartbeat')
    await second.request('availability', [true])
    expect(store.reconcileDriveBackedFiles).toHaveBeenCalledTimes(1)
  })
  it('isolates causal view handles by tab and releases them', async () => {
    const { host } = setup()
    const first = connect(host),
      second = connect(host)
    const view = (await first.request('createView', ['a'])) as {
      id: string
      heads: string[]
      initialNotebook: { cells: { refId: string }[] }
    }
    expect(view.heads).toEqual(['op-1'])
    expect(view.initialNotebook.cells).toEqual([{ refId: 'captured-cell' }])
    await expect(
      second.request('saveView', [view.id, 'a', {}])
    ).rejects.toThrow('view disconnected')
    await first.request('saveView', [view.id, 'a', {}])
    await first.request('releaseView', [view.id])
    await expect(first.request('saveView', [view.id, 'a', {}])).rejects.toThrow(
      'view disconnected'
    )
  })
})

it('answers diagnostics outside initialization and reports waiting requests without their contents', async () => {
  let initialize!: () => void
  const store = {
    ready: new Promise<void>((resolve) => {
      initialize = resolve
    }),
    setDriveSyncAvailable: vi.fn(),
    save: vi.fn(async () => {}),
  }
  const host = new StorageOwnerHost(store as unknown as LocalNotebooks)
  const client = connect(host)
  const saving = client.request('save', [
    'private-uri',
    { secret: 'notebook body' },
  ])
  const diagnostics = await client.diagnose()
  expect(diagnostics.initialization).toBe('pending')
  expect(diagnostics.oldestRequests).toEqual([
    {
      requestId: expect.any(String),
      method: 'save',
      elapsedMs: expect.any(Number),
      stage: 'initializing',
      stageElapsedMs: expect.any(Number),
    },
  ])
  expect(JSON.stringify(diagnostics)).not.toContain('private-uri')
  expect(JSON.stringify(diagnostics)).not.toContain('notebook body')
  initialize()
  await saving
  expect((await client.diagnose()).activeRequestCount).toBe(0)
})

it('reports executing requests while a commit is hung without retrying it', async () => {
  const { host, store } = setup()
  let finish!: () => void
  store.save.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const client = connect(host)
  const saving = client.request('save', ['a', {}])
  await vi.waitFor(() => expect(store.save).toHaveBeenCalledOnce())
  const first = client.diagnose()
  expect(client.diagnose()).toBe(first)
  expect((await first).oldestRequests[0].stage).toBe('executing')
  expect(store.save).toHaveBeenCalledOnce()
  finish()
  await saving
})

it('bounds and coalesces probes when a worker does not answer', async () => {
  vi.useFakeTimers()
  const port = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn() }
  const client = new StorageOwnerClient(
    port as unknown as MessagePort,
    async () => 'token'
  )
  clients.push(client)
  const probe = client.diagnose()
  expect(client.diagnose()).toBe(probe)
  const rejected = expect(probe).rejects.toThrow('may be unresponsive')
  await vi.advanceTimersByTimeAsync(5_000)
  await rejected
  expect(port.postMessage).toHaveBeenCalledOnce()
})

it('bounds diagnostics to the ten oldest requests while reporting the full backlog', async () => {
  const { host, store } = setup()
  let finish!: () => void
  const blocked = new Promise<void>((resolve) => {
    finish = resolve
  })
  store.save.mockImplementation(() => blocked)
  const client = connect(host)
  const writes = Array.from({ length: 12 }, () =>
    client.request('save', ['a', {}])
  )
  const first = await client.diagnose()
  expect(first.activeRequestCount).toBe(12)
  expect(first.oldestRequests).toHaveLength(10)
  expect((await client.diagnose()).instanceId).toBe(first.instanceId)
  finish()
  await Promise.all(writes)
  expect((await client.diagnose()).oldestRequests).toEqual([])
})

it('rechecks release admission after initialization before allowing effects', async () => {
  const { store } = setup()
  let initialize!: () => void
  Object.assign(store, {
    ready: new Promise<void>((resolve) => {
      initialize = resolve
    }),
  })
  let allowed = true
  const authorize = vi.fn(async () => {
    if (!allowed) throw new Error('stale epoch')
  })
  const host = new StorageOwnerHost(
    store as unknown as LocalNotebooks,
    undefined,
    authorize
  )
  const client = connect(host)
  const result = expect(client.request('save', ['a', {}])).rejects.toThrow(
    'stale epoch'
  )
  await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce())
  allowed = false
  initialize()
  await result
  expect(store.save).not.toHaveBeenCalled()
})

it('keeps handoff draining until an admitted write and maintenance complete', async () => {
  const { store } = setup()
  let finishWrite!: () => void, finishMaintenance!: () => void
  store.save.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishWrite = resolve
      })
  )
  const drain = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishMaintenance = resolve
      })
  )
  Object.assign(store, { drainForStorageRestart: drain })
  const host = new StorageOwnerHost(store as unknown as LocalNotebooks)
  const client = connect(host)
  const write = client.request('save', ['a', {}])
  await vi.waitFor(() => expect(store.save).toHaveBeenCalledOnce())
  let drained = false
  const handoff = host.drainForRelease().then(() => {
    drained = true
  })
  await expect(client.request('save', ['b', {}])).rejects.toThrow('draining')
  expect(drained).toBe(false)
  finishWrite()
  await write
  await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce())
  expect(drained).toBe(false)
  finishMaintenance()
  await handoff
  expect(drained).toBe(true)
})

it('blocks upgrade and mutation replay after a timeout until the original acknowledgement', async () => {
  vi.useFakeTimers()
  const channel = new MessageChannel()
  ports.push(channel.port1 as unknown as MessagePort)
  const client = new StorageOwnerClient(
    channel.port2 as unknown as MessagePort,
    async () => 'token'
  )
  clients.push(client)
  const sent: any[] = []
  channel.port1.on('message', (message) => sent.push(message))
  const outcome = expect(
    client.request('save', ['original', {}])
  ).rejects.toThrow('uncertain')
  await vi.advanceTimersByTimeAsync(300_000)
  await outcome
  expect(client.needsReconnect).toBe(false)
  const { assertNoUpgradeBlockers } = await import('../releases/runtime')
  expect(assertNoUpgradeBlockers).toThrow('unconfirmed')
  await expect(client.request('save', ['retry', {}])).rejects.toThrow(
    'unconfirmed'
  )
  await vi.waitFor(() =>
    expect(sent.some((m) => m.method === 'save')).toBe(true)
  )
  const original = sent.find((m) => m.method === 'save')
  channel.port1.postMessage({
    type: 'result',
    id: original.id,
    value: undefined,
  })
  await vi.waitFor(() => expect(assertNoUpgradeBlockers).not.toThrow())
  expect(sent.filter((m) => m.method === 'save')).toHaveLength(1)
})

it('allows reconnect after an editor-save timeout without requiring a stop notification', async () => {
  vi.useFakeTimers()
  const channel = new MessageChannel()
  ports.push(channel.port1 as unknown as MessagePort)
  const client = new StorageOwnerClient(
    channel.port2 as unknown as MessagePort,
    async () => 'token'
  )
  clients.push(client)
  const outcome = expect(
    client.request('commitEditorOperations', ['uri', 'notebook', []])
  ).rejects.toThrow('Pending operations remain')
  await vi.advanceTimersByTimeAsync(300_000)
  await outcome
  expect(client.needsReconnect).toBe(true)
  client.close()
  const { assertNoUpgradeBlockers } = await import('../releases/runtime')
  expect(assertNoUpgradeBlockers).not.toThrow()
})

it('does not treat disconnect as acknowledgement of an outstanding write', async () => {
  const channel = new MessageChannel()
  ports.push(channel.port1 as unknown as MessagePort)
  const client = new StorageOwnerClient(
    channel.port2 as unknown as MessagePort,
    async () => 'token'
  )
  clients.push(client)
  const saving = expect(
    client.request('save', ['pending', {}])
  ).rejects.toThrow('disconnected')
  client.close()
  await saving
  const { assertNoUpgradeBlockers } = await import('../releases/runtime')
  expect(assertNoUpgradeBlockers).toThrow('unconfirmed')
})

it.each([1, 2])(
  'distinguishes authorization pass %s from store initialization',
  async (pass) => {
    const { store } = setup()
    let resume!: () => void
    let calls = 0
    const authorize = async () => {
      if (++calls === pass)
        await new Promise<void>((resolve) => {
          resume = resolve
        })
    }
    const client = connect(
      new StorageOwnerHost(
        store as unknown as LocalNotebooks,
        undefined,
        authorize
      )
    )
    const saving = client.request('save', [
      'private-uri',
      { secret: 'notebook contents' },
    ])
    await vi.waitFor(() => expect(calls).toBe(pass))
    const snapshot = await client.diagnose()
    expect(snapshot.oldestRequests[0].stage).toBe(
      pass === 1 ? 'authorizing' : 'reauthorizing'
    )
    expect(store.save).not.toHaveBeenCalled()
    expect(JSON.stringify(snapshot)).not.toContain('notebook contents')
    resume()
    await saving
    expect(store.save).toHaveBeenCalledOnce()
  }
)
