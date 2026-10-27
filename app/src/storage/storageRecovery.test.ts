// @vitest-environment node
import { MessageChannel } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type LocalNotebooks from './local'
import { StorageOwnerClient } from './storageOwnerClient'
import { StorageOwnerHost } from './storageOwnerHost'
import { storageRecovery } from './storageRecovery'
import { StorageRecoveryClient } from './storageRecoveryClient'
import {
  type RecoveryMessage,
  recoveryMessage,
} from './storageRecoveryProtocol'

const clients: StorageOwnerClient[] = []
const ports: MessagePort[] = []
beforeEach(() => {
  storageRecovery.registerPreparation(
    async () => vi.fn(),
    () => 1
  )
})
afterEach(() => {
  clients.splice(0).forEach((client) => client.close())
  ports.splice(0).forEach((port) => port.close())
  vi.useRealTimers()
  storageRecovery.set({ phase: 'healthy', message: '' })
})
function setup() {
  const store = {
    setDriveSyncAvailable: vi.fn(),
    reconcileDriveBackedFiles: vi.fn(async () => []),
    save: vi.fn(async () => {}),
    drainForStorageRestart: vi.fn(async () => {}),
  }
  const shutdown = vi.fn()
  return {
    store,
    shutdown,
    host: new StorageOwnerHost(store as unknown as LocalNotebooks, shutdown),
  }
}
function connect(host: StorageOwnerHost, prepare = vi.fn(async () => vi.fn())) {
  const channel = new MessageChannel()
  const hostPort = channel.port1 as unknown as MessagePort
  const pagePort = channel.port2 as unknown as MessagePort
  ports.push(hostPort, pagePort)
  host.attach(hostPort)
  const client = new StorageOwnerClient(pagePort, async () => 'token')
  const reload = vi.fn()
  client.recovery = new StorageRecoveryClient(
    (message) => pagePort.postMessage(message),
    reload,
    prepare
  )
  pagePort.postMessage(recoveryMessage('register', 'editor-client'))
  clients.push(client)
  return { client, reload, prepare, pagePort }
}

describe('coordinated storage restart', () => {
  it('waits for all tabs and active commits before shutting down and reloading', async () => {
    const { host, store, shutdown } = setup()
    let finishSave!: () => void
    store.save.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        })
    )
    const first = connect(host)
    let preserveSecond!: () => void
    const second = connect(
      host,
      vi.fn(
        () =>
          new Promise<() => void>((resolve) => {
            preserveSecond = () => resolve(vi.fn())
          })
      )
    )
    const saving = first.client.request('save', ['a', {}])
    await vi.waitFor(() => expect(store.save).toHaveBeenCalled())
    first.client.recovery!.restart()
    await vi.waitFor(() => expect(second.prepare).toHaveBeenCalled())
    expect(shutdown).not.toHaveBeenCalled()
    preserveSecond()
    await vi.waitFor(() =>
      expect(storageRecovery.getSnapshot().phase).toBe('restarting')
    )
    await expect(first.client.request('save', ['b', {}])).rejects.toThrow(
      'restarting'
    )
    expect(store.save).toHaveBeenCalledTimes(1)
    expect(shutdown).not.toHaveBeenCalled()
    finishSave()
    await saving
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1))
    expect(store.drainForStorageRestart).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(first.reload).toHaveBeenCalledOnce()
      expect(second.reload).toHaveBeenCalledOnce()
    })
  })
  it('accepts recovery even when the data protocol is incompatible', async () => {
    const { host, shutdown, store } = setup()
    const page = connect(host)
    page.pagePort.postMessage({
      type: 'request',
      id: 'old-data',
      version: 0,
      method: 'save',
      args: ['a', {}],
    })
    page.client.recovery!.restart()
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
    expect(store.save).not.toHaveBeenCalled()
  })
  it('aborts without terminating the worker when one tab cannot preserve edits', async () => {
    const { host, shutdown } = setup()
    const release = vi.fn()
    const first = connect(
      host,
      vi.fn(async () => release)
    )
    connect(
      host,
      vi.fn(async () => {
        throw new Error('Recovery quota exceeded')
      })
    )
    first.client.recovery!.restart()
    await vi.waitFor(() =>
      expect(storageRecovery.getSnapshot().phase).toBe('blocked')
    )
    expect(shutdown).not.toHaveBeenCalled()
    expect(first.reload).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(release).toHaveBeenCalled())
  })
  it('does not force termination when an older tab never acknowledges', async () => {
    const { host, shutdown } = setup()
    const first = connect(host)
    const channel = new MessageChannel()
    ports.push(
      channel.port1 as unknown as MessagePort,
      channel.port2 as unknown as MessagePort
    )
    host.attach(channel.port1 as unknown as MessagePort)
    channel.port2.postMessage({
      type: 'request',
      id: 'legacy-hello',
      method: 'hello',
      version: 0,
      args: [],
    })
    await vi.waitFor(async () =>
      expect((await first.client.diagnose()).connectedTabs).toBe(2)
    )
    vi.useFakeTimers()
    first.client.recovery!.restart()
    await vi.waitFor(() => expect(first.prepare).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() =>
      expect(storageRecovery.getSnapshot().phase).toBe('blocked')
    )
    expect(shutdown).not.toHaveBeenCalled()
  })
  it('requires a tab arriving during draining to preserve its content', async () => {
    const { host, shutdown, store } = setup()
    let finishDrain!: () => void
    store.drainForStorageRestart.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve
        })
    )
    const first = connect(host)
    first.client.recovery!.restart()
    await vi.waitFor(() =>
      expect(store.drainForStorageRestart).toHaveBeenCalled()
    )
    let ready!: () => void
    const late = connect(
      host,
      vi.fn(
        () =>
          new Promise<() => void>((resolve) => {
            ready = () => resolve(vi.fn())
          })
      )
    )
    await vi.waitFor(() => expect(late.prepare).toHaveBeenCalled())
    finishDrain()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(shutdown).not.toHaveBeenCalled()
    ready()
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(late.reload).toHaveBeenCalledOnce())
  })
  it('shows an actionable fallback when the old worker ignores the restart protocol', async () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    const client = new StorageRecoveryClient(vi.fn(), reload)
    client.restart()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(storageRecovery.getSnapshot().message).toContain(
      'did not acknowledge restart'
    )
    expect(reload).not.toHaveBeenCalled()
  })
  it('releases a late preparation after a coordinated abort', async () => {
    const send = vi.fn<(message: RecoveryMessage) => void>()
    let ready!: (release: () => void) => void
    const release = vi.fn()
    const client = new StorageRecoveryClient(
      send,
      vi.fn(),
      () =>
        new Promise((resolve) => {
          ready = resolve
        })
    )
    const pending = client.receive(recoveryMessage('prepare', 'round'))
    await client.receive(
      recoveryMessage('blocked', 'round', 'Other tab failed')
    )
    ready(release)
    await pending
    expect(release).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  })
})

it('coalesces simultaneous restart clicks without preparing the same tab twice', async () => {
  const { host, shutdown } = setup()
  const first = connect(host),
    second = connect(host)
  first.client.recovery!.restart()
  second.client.recovery!.restart()
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
  expect(first.prepare).toHaveBeenCalledOnce()
  expect(second.prepare).toHaveBeenCalledOnce()
})

it('can retry after a late tab fails to preserve edits during draining', async () => {
  const { host, store, shutdown } = setup()
  let finish!: () => void
  store.drainForStorageRestart.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const first = connect(host)
  first.client.recovery!.restart()
  await vi.waitFor(() =>
    expect(store.drainForStorageRestart).toHaveBeenCalled()
  )
  const prepare = vi
    .fn(async () => vi.fn())
    .mockRejectedValueOnce(new Error('quota'))
  const late = connect(host, prepare)
  await vi.waitFor(() =>
    expect(storageRecovery.getSnapshot().phase).toBe('blocked')
  )
  finish()
  expect(shutdown).not.toHaveBeenCalled()
  late.client.recovery!.restart()
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
  expect(store.drainForStorageRestart).toHaveBeenCalledOnce()
})

it('releases a stale-version disconnected tab before restarting', async () => {
  const { host, shutdown } = setup()
  const first = connect(host),
    leaving = connect(host)
  leaving.pagePort.postMessage({
    type: 'request',
    id: 'bye',
    version: 0,
    method: 'disconnect',
    args: [],
  })
  first.client.recovery!.restart()
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
})

it('retains the actionable blocked reason while stale requests continue to fail', () => {
  storageRecovery.set({
    phase: 'blocked',
    message: 'Navigate older tabs away first.',
  })
  storageRecovery.report(new Error('Storage worker version mismatch'))
  expect(storageRecovery.getSnapshot().message).toBe(
    'Navigate older tabs away first.'
  )
})

it('aborts preparation when the host cancels a round, without acknowledging or reloading', async () => {
  const send = vi.fn<(message: RecoveryMessage) => void>()
  const reload = vi.fn()
  let signal!: AbortSignal
  const client = new StorageRecoveryClient(send, reload, async (incoming) => {
    signal = incoming
    await new Promise<void>((_resolve, reject) =>
      incoming.addEventListener('abort', () => reject(incoming.reason), {
        once: true,
      })
    )
    return vi.fn()
  })
  const preparing = client.receive(recoveryMessage('prepare', 'hung-round'))
  await client.receive(
    recoveryMessage('blocked', 'hung-round', 'Timed out waiting for tabs')
  )
  await preparing
  expect(signal.aborted).toBe(true)
  expect(send).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
})

it('backs up before sending restart even when the worker never replies', async () => {
  vi.useFakeTimers()
  const backup = vi.fn(() => 2)
  const prepare = vi.fn(async () => vi.fn())
  const send = vi.fn(() => expect(backup).toHaveBeenCalledOnce())
  const reload = vi.fn()
  const client = new StorageRecoveryClient(send, reload, prepare, backup)
  client.restart()
  client.restart()
  expect(send).toHaveBeenCalledOnce()
  expect(prepare).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(storageRecovery.getSnapshot().message).toContain('2 editor copies')
  expect(storageRecovery.getSnapshot().message).toContain(
    'Other tabs have not confirmed backups'
  )
  expect(reload).not.toHaveBeenCalled()
})

it('does not contact the worker or claim success when preflight backup fails', () => {
  const send = vi.fn()
  const client = new StorageRecoveryClient(send, vi.fn(), vi.fn(), () => {
    throw new Error('quota')
  })
  client.restart()
  expect(send).not.toHaveBeenCalled()
  expect(storageRecovery.getSnapshot().message).toContain('Get recovery copies')
  expect(storageRecovery.getSnapshot().message).toContain(
    'backup has not been confirmed'
  )
})

it('keeps confirmed backup status when sending restart fails', () => {
  const client = new StorageRecoveryClient(
    () => {
      throw new Error('closed')
    },
    vi.fn(),
    vi.fn(),
    () => 1
  )
  client.restart()
  expect(storageRecovery.getSnapshot().message).toContain('1 editor copies')
  expect(storageRecovery.getSnapshot().message).toContain('No automatic reload')
})

it('unfreezes a hung preparation when the worker disappears without sending blocked', async () => {
  vi.useFakeTimers()
  let signal!: AbortSignal
  const send = vi.fn()
  const reload = vi.fn()
  const client = new StorageRecoveryClient(send, reload, async (incoming) => {
    signal = incoming
    await new Promise<void>((_resolve, reject) =>
      incoming.addEventListener('abort', () => reject(incoming.reason))
    )
    return vi.fn()
  })
  const preparing = client.receive(recoveryMessage('prepare', 'round'))
  await client.receive(recoveryMessage('prepare', 'round'))
  await vi.advanceTimersByTimeAsync(30_000)
  await preparing
  expect(signal.aborted).toBe(true)
  expect(send).not.toHaveBeenCalled()
  await client.receive(recoveryMessage('reload', 'round'))
  expect(reload).not.toHaveBeenCalled()
})

it('rejects a stale preparation result when the host reuses a timed-out round ID', async () => {
  vi.useFakeTimers()
  let finishOld!: (release: () => void) => void
  const oldRelease = vi.fn()
  const newRelease = vi.fn()
  const prepare = vi
    .fn<() => Promise<() => void>>(async () => newRelease)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        })
    )
  const send = vi.fn()
  const client = new StorageRecoveryClient(send, vi.fn(), prepare)
  const oldPreparation = client.receive(
    recoveryMessage('prepare', 'same-round')
  )
  await vi.advanceTimersByTimeAsync(30_000)
  await client.receive(recoveryMessage('prepare', 'same-round'))
  expect(send).toHaveBeenCalledOnce()
  finishOld(oldRelease)
  await oldPreparation
  expect(oldRelease).toHaveBeenCalledOnce()
  expect(newRelease).not.toHaveBeenCalled()
  expect(send).toHaveBeenCalledOnce()
  client.disconnected()
  expect(newRelease).toHaveBeenCalledOnce()
})

it('releases preserved editors if sending the ready acknowledgement throws', async () => {
  const release = vi.fn()
  const client = new StorageRecoveryClient(
    () => {
      throw new Error('closed')
    },
    vi.fn(),
    async () => release
  )
  await client.receive(recoveryMessage('prepare', 'round'))
  expect(release).toHaveBeenCalledOnce()
  expect(storageRecovery.getSnapshot().phase).toBe('blocked')
})

it('offers recovery for a release-settings failure before the RPC deadline', async () => {
  const { requiresStorageReload } = await import('./storageRecovery')
  expect(
    requiresStorageReload(
      new Error(
        'Release settings read timeout (get). Stored notebook data has not been removed.'
      )
    )
  ).toBe(true)
  expect(
    requiresStorageReload(
      new Error(
        'Stale or frozen release: storage request rejected before effects'
      )
    )
  ).toBe(false)
})

it('does not count the launcher control connection as an editor tab', async () => {
  const { host, shutdown } = setup()
  const editor = connect(host)
  const launcher = new MessageChannel()
  ports.push(
    launcher.port1 as unknown as MessagePort,
    launcher.port2 as unknown as MessagePort
  )
  host.attach(launcher.port1 as unknown as MessagePort)
  const messages: unknown[] = []
  launcher.port2.on('message', (message) => messages.push(message))
  await vi.waitFor(async () =>
    expect((await editor.client.diagnose()).connectedTabs).toBe(1)
  )
  expect((await editor.client.diagnose()).connectedPorts).toBe(2)
  editor.client.recovery!.restart()
  await vi.waitFor(() => expect(editor.reload).toHaveBeenCalledOnce())
  expect(shutdown).toHaveBeenCalledOnce()
  expect(messages).toEqual([])
})

it('backs up and restarts an admitted owner without consulting release settings', async () => {
  const { store, shutdown } = setup()
  const module = await import('../releases/control')
  const control = vi
    .spyOn(module, 'control')
    .mockImplementation(() => new Promise(() => {}))
  try {
    const host = new StorageOwnerHost(
      store as unknown as LocalNotebooks,
      shutdown,
      undefined,
      { releaseId: 'test', epoch: 1, capabilities: [] }
    )
    const editor = connect(host)
    editor.client.recovery!.restart()
    await vi.waitFor(() => expect(editor.reload).toHaveBeenCalledOnce())
    expect(editor.prepare).toHaveBeenCalledOnce()
    expect(control).not.toHaveBeenCalled()
    expect(shutdown).toHaveBeenCalledOnce()
  } finally {
    control.mockRestore()
  }
})
