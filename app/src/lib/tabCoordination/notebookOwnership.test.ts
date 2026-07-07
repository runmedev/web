// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetTabIdForTests } from '../tabIdentity'
import { NotebookOwnershipManager } from './notebookOwnership'

const dexieState = vi.hoisted(() => ({
  databases: new Map<string, Map<string, unknown>>(),
}))

vi.mock('dexie', () => {
  class MockDexie {
    private readonly databaseName: string

    constructor(databaseName: string) {
      this.databaseName = databaseName
    }

    version() {
      return {
        stores: () => this,
      }
    }

    table() {
      let records = dexieState.databases.get(this.databaseName)
      if (!records) {
        records = new Map<string, unknown>()
        dexieState.databases.set(this.databaseName, records)
      }
      return {
        put: async (record: { notebookUri: string }) => {
          records.set(record.notebookUri, record)
        },
        get: async (notebookUri: string) => records.get(notebookUri),
        delete: async (notebookUri: string) => {
          records.delete(notebookUri)
        },
      }
    }

    close() {}
  }

  return { default: MockDexie }
})

type LockCallback = (
  lock: { name: string } | null
) => Promise<unknown> | unknown

const heldLocks = new Map<string, Promise<unknown>>()

class FakeOwnershipChannelBus {
  private readonly channels = new Set<FakeOwnershipChannel>()

  createChannel(): FakeOwnershipChannel {
    const channel = new FakeOwnershipChannel(this)
    this.channels.add(channel)
    return channel
  }

  post(sender: FakeOwnershipChannel, message: unknown): void {
    queueMicrotask(() => {
      for (const channel of this.channels) {
        if (channel !== sender) {
          channel.deliver(message)
        }
      }
    })
  }

  close(channel: FakeOwnershipChannel): void {
    this.channels.delete(channel)
  }
}

class FakeOwnershipChannel {
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()

  constructor(private readonly bus: FakeOwnershipChannelBus) {}

  addEventListener(
    _type: 'message',
    listener: (event: MessageEvent<unknown>) => void
  ): void {
    this.listeners.add(listener)
  }

  postMessage(message: unknown): void {
    this.bus.post(this, message)
  }

  deliver(message: unknown): void {
    for (const listener of this.listeners) {
      listener(new MessageEvent('message', { data: message }))
    }
  }

  close(): void {
    this.listeners.clear()
    this.bus.close(this)
  }
}

function installFakeWebLocks(): void {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: vi.fn(
        async (
          name: string,
          options: { ifAvailable?: boolean },
          callback: LockCallback
        ) => {
          if (heldLocks.has(name) && options.ifAvailable) {
            return callback(null)
          }
          const result = Promise.resolve(callback({ name })).finally(() => {
            heldLocks.delete(name)
          })
          heldLocks.set(name, result)
          return result
        }
      ),
    },
  })
}

async function flushReleasedNotebookLocks(): Promise<void> {
  await vi.waitFor(() => {
    expect(
      Array.from(heldLocks.keys()).filter((name) =>
        name.startsWith('runme:notebook:')
      )
    ).toEqual([])
  })
}

describe('NotebookOwnershipManager', () => {
  beforeEach(() => {
    __resetTabIdForTests()
    dexieState.databases.clear()
    heldLocks.clear()
    installFakeWebLocks()
    document.title = 'Runme Test'
    window.history.replaceState(null, '', '/notebooks')
  })

  it('returns unsupported when Web Locks are unavailable', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    })
    const manager = new NotebookOwnershipManager({
      dbName: 'unsupported-test',
      tabId: 'tab-a',
    })

    await expect(manager.acquire('local://file/a')).resolves.toEqual({
      status: 'unsupported',
      reason: 'web_locks_unavailable',
    })

    manager.dispose()
  })

  it('blocks another tab while a notebook lock is held', async () => {
    const first = new NotebookOwnershipManager({
      dbName: 'blocked-test',
      tabId: 'tab-a',
    })
    const second = new NotebookOwnershipManager({
      dbName: 'blocked-test',
      tabId: 'tab-b',
    })

    const acquired = await first.acquire('local://file/a')
    expect(acquired.status).toBe('acquired')
    const blocked = await second.acquire('local://file/a')

    expect(blocked.status).toBe('blocked')
    if (blocked.status === 'blocked') {
      expect(blocked.owner).toEqual(
        expect.objectContaining({
          notebookUri: 'local://file/a',
          ownerTabId: 'tab-a',
          ownerSessionId: expect.any(String),
          ownerLabel: 'Runme Test',
        })
      )
    }

    if (acquired.status === 'acquired') {
      acquired.lease.release()
    }
    await flushReleasedNotebookLocks()
    first.dispose()
    second.dispose()
  })

  it('releases ownership so another tab can acquire the notebook', async () => {
    const first = new NotebookOwnershipManager({
      dbName: 'release-test',
      tabId: 'tab-a',
    })
    const second = new NotebookOwnershipManager({
      dbName: 'release-test',
      tabId: 'tab-b',
    })

    const acquired = await first.acquire('local://file/a')
    expect(acquired.status).toBe('acquired')
    if (acquired.status === 'acquired') {
      acquired.lease.release()
    }
    await flushReleasedNotebookLocks()

    const reacquired = await second.acquire('local://file/a')

    expect(reacquired.status).toBe('acquired')
    if (reacquired.status === 'acquired') {
      reacquired.lease.release()
    }
    await flushReleasedNotebookLocks()
    first.dispose()
    second.dispose()
  })

  it('does not report stale same-tab ownership after release starts', async () => {
    const manager = new NotebookOwnershipManager({
      dbName: 'stale-release-test',
      tabId: 'tab-a',
    })

    const acquired = await manager.acquire('local://file/a')
    expect(acquired.status).toBe('acquired')
    if (acquired.status !== 'acquired') {
      return
    }

    acquired.lease.release()

    const ownerCheck = acquired.lease.isCurrentOwner()
    const reacquire = manager.acquire('local://file/a')

    await expect(ownerCheck).resolves.toBe(false)
    await expect(reacquire).resolves.toEqual(
      expect.objectContaining({ status: 'blocked' })
    )

    await flushReleasedNotebookLocks()
    manager.dispose()
  })

  it('broadcasts by notebook and lets only the live owner release', async () => {
    const bus = new FakeOwnershipChannelBus()
    const first = new NotebookOwnershipManager({
      dbName: 'force-release-test',
      tabId: 'tab-owner',
      channel: bus.createChannel(),
    })
    const requester = new NotebookOwnershipManager({
      dbName: 'force-release-test',
      tabId: 'tab-requester',
      channel: bus.createChannel(),
    })
    const nonOwner = new NotebookOwnershipManager({
      dbName: 'force-release-test',
      tabId: 'tab-non-owner',
      channel: bus.createChannel(),
    })
    const acquired = await first.acquire('local://file/a')
    expect(acquired.status).toBe('acquired')
    if (acquired.status !== 'acquired') {
      return
    }
    const ownerHandler = vi.fn(async () => {
      acquired.lease.release()
      await acquired.lease.released
      return { status: 'released' as const }
    })
    const nonOwnerHandler = vi.fn(async () => ({ status: 'released' as const }))
    first.setForceReleaseHandler(ownerHandler)
    nonOwner.setForceReleaseHandler(nonOwnerHandler)

    await expect(
      requester.requestForceRelease('local://file/a', { timeoutMs: 100 })
    ).resolves.toEqual({ status: 'released' })

    expect(ownerHandler).toHaveBeenCalledTimes(1)
    expect(nonOwnerHandler).not.toHaveBeenCalled()
    const requesterAcquire = await requester.acquire('local://file/a')
    expect(requesterAcquire.status).toBe('acquired')
    if (requesterAcquire.status === 'acquired') {
      requesterAcquire.lease.release()
      await requesterAcquire.lease.released
    }
    first.dispose()
    requester.dispose()
    nonOwner.dispose()
  })

  it('ignores expired force-release requests', async () => {
    const bus = new FakeOwnershipChannelBus()
    const ownerChannel = bus.createChannel()
    const senderChannel = bus.createChannel()
    const owner = new NotebookOwnershipManager({
      dbName: 'expired-request-test',
      tabId: 'tab-owner',
      channel: ownerChannel,
    })
    const acquired = await owner.acquire('local://file/a')
    expect(acquired.status).toBe('acquired')
    const handler = vi.fn(async () => ({ status: 'released' as const }))
    owner.setForceReleaseHandler(handler)

    senderChannel.postMessage({
      type: 'force-release-request',
      requestId: 'expired',
      notebookUri: 'local://file/a',
      requesterTabId: 'tab-requester',
      requesterLabel: 'Requester',
      requesterUrl: 'http://localhost/requester',
      createdAt: new Date(Date.now() - 20_000).toISOString(),
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(handler).not.toHaveBeenCalled()
    if (acquired.status === 'acquired') {
      acquired.lease.release()
      await acquired.lease.released
    }
    owner.dispose()
    senderChannel.close()
  })

  it('ignores stale force-release requests with future expirations', async () => {
    const bus = new FakeOwnershipChannelBus()
    const ownerChannel = bus.createChannel()
    const senderChannel = bus.createChannel()
    const owner = new NotebookOwnershipManager({
      dbName: 'stale-request-test',
      tabId: 'tab-owner',
      channel: ownerChannel,
    })
    const acquired = await owner.acquire('local://file/a')
    expect(acquired.status).toBe('acquired')
    const handler = vi.fn(async () => ({ status: 'released' as const }))
    owner.setForceReleaseHandler(handler)

    senderChannel.postMessage({
      type: 'force-release-request',
      requestId: 'stale',
      notebookUri: 'local://file/a',
      requesterTabId: 'tab-requester',
      requesterLabel: 'Requester',
      requesterUrl: 'http://localhost/requester',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(handler).not.toHaveBeenCalled()
    if (acquired.status === 'acquired') {
      acquired.lease.release()
      await acquired.lease.released
    }
    owner.dispose()
    senderChannel.close()
  })

  it('returns a retryable timeout without automatically retrying', async () => {
    const bus = new FakeOwnershipChannelBus()
    const requester = new NotebookOwnershipManager({
      dbName: 'force-release-timeout-test',
      tabId: 'tab-requester',
      channel: bus.createChannel(),
    })

    await expect(
      requester.requestForceRelease('local://file/a', { timeoutMs: 5 })
    ).resolves.toEqual({
      status: 'timeout',
      message:
        'The other session did not respond. The notebook is still read-only.',
    })

    requester.dispose()
  })
})
