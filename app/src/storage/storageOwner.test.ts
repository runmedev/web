// @vitest-environment node
import { MessageChannel } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DriveCreateNotCommittedError } from './drive'
import { FilesystemEntryAlreadyExistsError } from './fs'
import type LocalNotebooks from './local'
import { StorageOwnerClient } from './storageOwnerClient'
import { StorageOwnerHost } from './storageOwnerHost'

const clients: StorageOwnerClient[] = []
const ports: MessagePort[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  for (const port of ports.splice(0)) port.close()
})
function connect(host: StorageOwnerHost, token = async () => 'token') {
  const channel = new MessageChannel()
  const port = channel.port1 as unknown as MessagePort
  ports.push(port)
  host.attach(port)
  const client = new StorageOwnerClient(
    channel.port2 as unknown as MessagePort,
    token
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
    const error = await client.request('save', ['a', {}]).catch(error => error)
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
