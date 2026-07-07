import { create } from '@bufbuild/protobuf'
import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../contexts/CellContext'
import type { LocalNotebooks } from '../storage/local'
import { NotebookStoreItemType } from '../storage/notebook'
import {
  __resetNotebookDataControllerForTests,
  getNotebookDataController,
} from './notebookDataController'
import type {
  AcquireResult,
  ForceReleaseRequest,
  NotebookOwnershipManager,
  NotebookOwnershipMessage,
} from './tabCoordination/notebookOwnership'

vi.mock('@runmedev/renderers', () => ({
  Streams: class {},
  Heartbeat: { INITIAL: 'INITIAL' },
  genRunID: () => 'run-generated',
}))

function createNotebook(value = ''): parser_pb.Notebook {
  return create(parser_pb.NotebookSchema, {
    cells: value
      ? [
          create(parser_pb.CellSchema, {
            refId: 'cell-1',
            value,
          }),
        ]
      : [],
    metadata: {},
  })
}

function createFakeLocalNotebooks() {
  const records = new Map<
    string,
    {
      id: string
      name: string
      remoteId: string
      notebook: parser_pb.Notebook
    }
  >()
  let nextId = 1

  return {
    records,
    addFile: vi.fn(async (remoteUri: string, name?: string) => {
      for (const record of records.values()) {
        if (record.remoteId === remoteUri) {
          if (name) {
            record.name = name
          }
          return record.id
        }
      }
      const id = `local://file/${nextId++}`
      records.set(id, {
        id,
        name: name ?? remoteUri,
        remoteId: remoteUri,
        notebook: createNotebook(),
      })
      return id
    }),
    getMetadata: vi.fn(async (uri: string) => {
      const record = records.get(uri)
      if (!record) {
        return null
      }
      return {
        uri: record.id,
        name: record.name,
        type: NotebookStoreItemType.File,
        children: [],
        parents: [],
        remoteUri: record.remoteId === record.id ? undefined : record.remoteId,
      }
    }),
    load: vi.fn(async (uri: string) => {
      const record = records.get(uri)
      if (!record) {
        throw new Error(`Local notebook record not found for ${uri}`)
      }
      return record.notebook
    }),
    save: vi.fn(),
  }
}

function createFakeOwnershipManager(
  acquireResult?: AcquireResult
): NotebookOwnershipManager {
  const fallbackLease = {
    notebookUri: 'local://file/demo',
    tabId: 'tab-test',
    epoch: 'epoch-test',
    release: vi.fn(),
    released: Promise.resolve(),
    isCurrentOwner: vi.fn(async () => true),
  }
  return {
    acquire: vi.fn(async (notebookUri: string) => {
      if (acquireResult) {
        return acquireResult
      }
      return {
        status: 'acquired',
        lease: {
          ...fallbackLease,
          notebookUri,
        },
      }
    }),
    release: vi.fn(),
    getOwner: vi.fn(async () => null),
    subscribe: vi.fn(() => () => {}),
    subscribeToMessages: vi.fn(() => () => {}),
    setForceReleaseHandler: vi.fn(() => () => {}),
    requestForceRelease: vi.fn(async () => ({ status: 'released' })),
    isCurrentOwner: vi.fn(async () => true),
    dispose: vi.fn(),
  } as unknown as NotebookOwnershipManager
}

function createForceReleaseRequest(notebookUri: string): ForceReleaseRequest {
  const now = Date.now()
  return {
    type: 'force-release-request',
    requestId: 'request-test',
    notebookUri,
    requesterTabId: 'tab-requester',
    requesterLabel: 'Requester',
    requesterUrl: 'http://localhost/requester',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10_000).toISOString(),
  }
}

describe('NotebookDataController', () => {
  beforeEach(() => {
    __resetNotebookDataControllerForTests()
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it('opens a local notebook and loads NotebookData', async () => {
    const localStore = createFakeLocalNotebooks()
    localStore.records.set('local://file/demo', {
      id: 'local://file/demo',
      name: 'demo.json',
      remoteId: 'local://file/demo',
      notebook: createNotebook("console.log('demo')"),
    })

    const controller = getNotebookDataController()
    controller.configureOwnershipManager(createFakeOwnershipManager())
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })

    const result = await controller.openNotebook('local://file/demo')

    expect(result.localUri).toBe('local://file/demo')
    expect(controller.getOpenNotebooks()).toEqual([
      expect.objectContaining({
        uri: 'local://file/demo',
        requestedUri: 'local://file/demo',
        name: 'demo.json',
        state: 'loaded',
      }),
    ])
    expect(
      controller.getNotebookData('local://file/demo')?.getSnapshot()
    ).toEqual(
      expect.objectContaining({
        uri: 'local://file/demo',
        name: 'demo.json',
        loaded: true,
      })
    )
  })

  it('resolves a remote URI to a stable local URI before loading', async () => {
    const localStore = createFakeLocalNotebooks()
    localStore.records.set('local://file/existing', {
      id: 'local://file/existing',
      name: 'existing.json',
      remoteId: 'fs://workspace/demo/file/existing.json',
      notebook: createNotebook("console.log('existing')"),
    })
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(createFakeOwnershipManager())
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })

    const result = await controller.openNotebook(
      'fs://workspace/demo/file/existing.json',
      { name: 'renamed.json' }
    )

    expect(localStore.addFile).toHaveBeenCalledWith(
      'fs://workspace/demo/file/existing.json',
      'renamed.json'
    )
    expect(result.localUri).toBe('local://file/existing')
    expect(controller.getOpenNotebooks()[0]).toEqual(
      expect.objectContaining({
        uri: 'local://file/existing',
        requestedUri: 'fs://workspace/demo/file/existing.json',
        name: 'renamed.json',
        state: 'loaded',
      })
    )
  })

  it('updates the open notebook entry when the loaded notebook name changes', async () => {
    const localStore = createFakeLocalNotebooks()
    localStore.records.set('local://file/demo', {
      id: 'local://file/demo',
      name: 'demo.json',
      remoteId: 'local://file/demo',
      notebook: createNotebook("console.log('demo')"),
    })
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(createFakeOwnershipManager())
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })
    await controller.openNotebook('local://file/demo')

    controller.getNotebookData('local://file/demo')?.setName('renamed.json')

    expect(controller.getOpenNotebooks()[0]).toEqual(
      expect.objectContaining({
        uri: 'local://file/demo',
        name: 'renamed.json',
        state: 'loaded',
      })
    )
    expect(
      JSON.parse(window.sessionStorage.getItem('runme/openNotebooks') ?? '[]')
    ).toEqual([
      expect.objectContaining({
        uri: 'local://file/demo',
        name: 'renamed.json',
      }),
    ])
  })

  it('closes a notebook, disposes its model, and returns a fallback URI', async () => {
    const localStore = createFakeLocalNotebooks()
    localStore.records.set('local://file/a', {
      id: 'local://file/a',
      name: 'a.json',
      remoteId: 'local://file/a',
      notebook: createNotebook('a'),
    })
    localStore.records.set('local://file/b', {
      id: 'local://file/b',
      name: 'b.json',
      remoteId: 'local://file/b',
      notebook: createNotebook('b'),
    })
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(createFakeOwnershipManager())
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })
    await controller.openNotebook('local://file/a')
    await controller.openNotebook('local://file/b')

    const fallback = controller.closeNotebook('local://file/b')

    expect(fallback).toBe('local://file/a')
    expect(controller.getNotebookData('local://file/b')).toBeUndefined()
    expect(controller.getOpenNotebooks().map((item) => item.uri)).toEqual([
      'local://file/a',
    ])
  })

  it('returns null and leaves selection candidates unchanged when closing a stale URI', async () => {
    const localStore = createFakeLocalNotebooks()
    localStore.records.set('local://file/a', {
      id: 'local://file/a',
      name: 'a.json',
      remoteId: 'local://file/a',
      notebook: createNotebook('a'),
    })
    localStore.records.set('local://file/b', {
      id: 'local://file/b',
      name: 'b.json',
      remoteId: 'local://file/b',
      notebook: createNotebook('b'),
    })
    const controller = getNotebookDataController()
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })
    await controller.openNotebook('local://file/a')
    await controller.openNotebook('local://file/b')

    const fallback = controller.closeNotebook('local://file/missing')

    expect(fallback).toBeNull()
    expect(controller.getOpenNotebooks().map((item) => item.uri)).toEqual([
      'local://file/a',
      'local://file/b',
    ])
  })

  it('restores session open-notebook storage as load intents only', () => {
    window.sessionStorage.setItem(
      'runme/openNotebooks',
      JSON.stringify([
        {
          uri: 'local://file/restored',
          requestedUri: 'local://file/restored',
          name: 'restored.json',
          state: 'loaded',
          readOnly: true,
          errorMessage: 'stale error',
          owner: {
            notebookUri: 'local://file/restored',
            ownerTabId: 'tab-other',
            ownerLabel: 'Other tab',
            ownerUrl: 'http://localhost/',
            ownerStartedAt: '2026-05-22T12:00:00.000Z',
            epoch: 'epoch-other',
          },
          type: 'file',
          children: [],
          parents: [],
        },
      ])
    )

    const controller = getNotebookDataController()
    controller.configureOwnershipManager(createFakeOwnershipManager())

    const restored = controller.getOpenNotebooks()
    expect(restored).toEqual([
      expect.objectContaining({
        uri: 'local://file/restored',
        requestedUri: 'local://file/restored',
        name: 'restored.json',
        state: 'loading',
      }),
    ])
    expect(restored[0]).not.toHaveProperty('readOnly')
    expect(restored[0]).not.toHaveProperty('errorMessage')
    expect(restored[0]).not.toHaveProperty('owner')
    expect(controller.getNotebookData('local://file/restored')).toBeUndefined()
    controller.configureStores({
      localNotebooks: createFakeLocalNotebooks() as unknown as LocalNotebooks,
    })
    expect(
      JSON.parse(window.sessionStorage.getItem('runme/openNotebooks') ?? '[]')
    ).toEqual([
      expect.objectContaining({
        uri: 'local://file/restored',
        name: 'restored.json',
      }),
    ])
  })

  it('opens blocked notebooks as read-only', async () => {
    const localStore = createFakeLocalNotebooks()
    localStore.records.set('local://file/blocked', {
      id: 'local://file/blocked',
      name: 'blocked.json',
      remoteId: 'local://file/blocked',
      notebook: createNotebook('blocked'),
    })
    const owner = {
      notebookUri: 'local://file/blocked',
      ownerTabId: 'tab-other',
      ownerLabel: 'Other tab',
      ownerUrl: 'http://localhost/',
      ownerStartedAt: '2026-05-22T12:00:00.000Z',
      epoch: 'epoch-other',
    }
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(
      createFakeOwnershipManager({ status: 'blocked', owner })
    )
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })

    const result = await controller.openNotebook('local://file/blocked')

    expect(result.entry).toEqual(
      expect.objectContaining({
        uri: 'local://file/blocked',
        state: 'loaded',
        readOnly: true,
        owner,
      })
    )
    const data = controller.getNotebookData('local://file/blocked')
    expect(data?.isReadOnly()).toBe(true)
    expect(data?.getSnapshot()).toEqual(
      expect.objectContaining({
        uri: 'local://file/blocked',
        loaded: true,
        readOnly: true,
      })
    )
  })

  it('restores blocked notebooks without loading read-only content', async () => {
    const localStore = createFakeLocalNotebooks()
    localStore.records.set('local://file/blocked', {
      id: 'local://file/blocked',
      name: 'blocked.json',
      remoteId: 'local://file/blocked',
      notebook: createNotebook('blocked'),
    })
    window.sessionStorage.setItem(
      'runme/openNotebooks',
      JSON.stringify([
        {
          uri: 'local://file/blocked',
          requestedUri: 'local://file/blocked',
          name: 'blocked.json',
          state: 'loaded',
        },
      ])
    )
    const owner = {
      notebookUri: 'local://file/blocked',
      ownerTabId: 'tab-other',
      ownerLabel: 'Other tab',
      ownerUrl: 'http://localhost/',
      ownerStartedAt: '2026-05-22T12:00:00.000Z',
      epoch: 'epoch-other',
    }
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(
      createFakeOwnershipManager({ status: 'blocked', owner })
    )

    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })

    await waitFor(() => {
      expect(controller.getOpenNotebooks()[0]).toEqual(
        expect.objectContaining({
          uri: 'local://file/blocked',
          state: 'blocked',
          readOnly: false,
          owner,
        })
      )
    })
    expect(localStore.load).not.toHaveBeenCalled()
    expect(controller.getNotebookData('local://file/blocked')).toBeUndefined()
  })

  it('returns unsupported state without creating editable NotebookData', async () => {
    const localStore = createFakeLocalNotebooks()
    localStore.records.set('local://file/unsupported', {
      id: 'local://file/unsupported',
      name: 'unsupported.json',
      remoteId: 'local://file/unsupported',
      notebook: createNotebook('unsupported'),
    })
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(
      createFakeOwnershipManager({
        status: 'unsupported',
        reason: 'web_locks_unavailable',
      })
    )
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })

    const result = await controller.openNotebook('local://file/unsupported')

    expect(result.entry).toEqual(
      expect.objectContaining({
        uri: 'local://file/unsupported',
        state: 'error',
      })
    )
    expect(result.entry.errorMessage).toContain('does not support')
    expect(result.entry.errorMessage).toContain('Web Locks')
    expect(
      controller.getNotebookData('local://file/unsupported')
    ).toBeUndefined()
  })

  it('releases notebook ownership when loading the local notebook fails', async () => {
    const localStore = createFakeLocalNotebooks()
    localStore.records.set('local://file/load-error', {
      id: 'local://file/load-error',
      name: 'load-error.json',
      remoteId: 'local://file/load-error',
      notebook: createNotebook('load error'),
    })
    localStore.load.mockRejectedValueOnce(new Error('load failed'))
    const release = vi.fn()
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(
      createFakeOwnershipManager({
        status: 'acquired',
        lease: {
          notebookUri: 'local://file/load-error',
          tabId: 'tab-test',
          epoch: 'epoch-test',
          release,
          released: Promise.resolve(),
          isCurrentOwner: vi.fn(async () => true),
        },
      })
    )
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })

    const result = await controller.openNotebook('local://file/load-error')

    expect(result.entry).toEqual(
      expect.objectContaining({
        uri: 'local://file/load-error',
        state: 'error',
      })
    )
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('does not release an existing loaded notebook when a duplicate open cannot reload', async () => {
    const localStore = createFakeLocalNotebooks()
    localStore.records.set('local://file/demo', {
      id: 'local://file/demo',
      name: 'demo.json',
      remoteId: 'local://file/demo',
      notebook: createNotebook('loaded'),
    })
    const release = vi.fn()
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(
      createFakeOwnershipManager({
        status: 'acquired',
        lease: {
          notebookUri: 'local://file/demo',
          tabId: 'tab-test',
          epoch: 'epoch-test',
          release,
          released: Promise.resolve(),
          isCurrentOwner: vi.fn(async () => true),
        },
      })
    )
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })

    await controller.openNotebook('local://file/demo')
    localStore.load.mockRejectedValueOnce(new Error('load failed'))

    const result = await controller.openNotebook('local://file/demo')

    expect(result.entry).toEqual(
      expect.objectContaining({
        uri: 'local://file/demo',
        state: 'loaded',
      })
    )
    expect(
      controller.getNotebookData('local://file/demo')?.getSnapshot().loaded
    ).toBe(true)
    expect(release).not.toHaveBeenCalled()
  })

  it('locks, flushes, and converts the owner to read-only before releasing', async () => {
    const uri = 'local://file/owned'
    const localStore = createFakeLocalNotebooks()
    localStore.records.set(uri, {
      id: uri,
      name: 'owned.json',
      remoteId: uri,
      notebook: createNotebook('before'),
    })
    let finishSave!: () => void
    localStore.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        })
    )
    const release = vi.fn()
    const lease = {
      notebookUri: uri,
      tabId: 'tab-owner',
      epoch: 'epoch-owner',
      release,
      released: Promise.resolve(),
      isCurrentOwner: vi.fn(async () => true),
    }
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(
      createFakeOwnershipManager({ status: 'acquired', lease })
    )
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })
    await controller.openNotebook(uri)
    const data = controller.getNotebookData(uri)!
    const cancelExecutions = vi.spyOn(data, 'cancelActiveExecutions')

    const releaseResult = controller.forceReleaseNotebook(
      createForceReleaseRequest(uri)
    )

    await waitFor(() => {
      expect(data.getSnapshot().releasePending).toBe(true)
    })
    expect(() => data.appendCell()).toThrow('releasing its write lock')
    expect(cancelExecutions).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()

    finishSave()
    await expect(releaseResult).resolves.toEqual({ status: 'released' })

    expect(release).toHaveBeenCalledTimes(1)
    expect(localStore.save.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0]!
    )
    expect(data.getSnapshot()).toEqual(
      expect.objectContaining({ readOnly: true, releasePending: false })
    )
    expect(controller.getOpenNotebooks()[0]).toEqual(
      expect.objectContaining({ readOnly: true, releasePending: false })
    )
  })

  it('keeps ownership when the final save fails', async () => {
    const uri = 'local://file/save-failure'
    const localStore = createFakeLocalNotebooks()
    localStore.records.set(uri, {
      id: uri,
      name: 'save-failure.json',
      remoteId: uri,
      notebook: createNotebook('before'),
    })
    localStore.save.mockRejectedValueOnce(new Error('disk full'))
    const release = vi.fn()
    const lease = {
      notebookUri: uri,
      tabId: 'tab-owner',
      epoch: 'epoch-owner',
      release,
      released: Promise.resolve(),
      isCurrentOwner: vi.fn(async () => true),
    }
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(
      createFakeOwnershipManager({ status: 'acquired', lease })
    )
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })
    await controller.openNotebook(uri)

    const result = await controller.forceReleaseNotebook(
      createForceReleaseRequest(uri)
    )

    expect(result).toEqual(
      expect.objectContaining({ status: 'failed', message: expect.any(String) })
    )
    expect(release).not.toHaveBeenCalled()
    expect(controller.getNotebookData(uri)?.getSnapshot()).toEqual(
      expect.objectContaining({ readOnly: false, releasePending: false })
    )
  })

  it('reloads when the new owner acquires before release cleanup finishes', async () => {
    const uri = 'local://file/release-race'
    const localStore = createFakeLocalNotebooks()
    const record = {
      id: uri,
      name: 'release-race.json',
      remoteId: uri,
      notebook: createNotebook('owner save'),
    }
    localStore.records.set(uri, record)
    let finishRelease!: () => void
    const released = new Promise<void>((resolve) => {
      finishRelease = resolve
    })
    const lease = {
      notebookUri: uri,
      tabId: 'tab-owner',
      epoch: 'epoch-owner',
      release: vi.fn(),
      released,
      isCurrentOwner: vi.fn(async () => true),
    }
    const newOwner = {
      notebookUri: uri,
      ownerTabId: 'tab-requester',
      ownerLabel: 'Requester',
      ownerUrl: 'http://localhost/requester',
      ownerStartedAt: new Date().toISOString(),
      epoch: 'epoch-requester',
    }
    let messageListener: ((message: NotebookOwnershipMessage) => void) | null =
      null
    const manager = createFakeOwnershipManager({ status: 'acquired', lease })
    vi.mocked(manager.subscribeToMessages).mockImplementation((listener) => {
      messageListener = listener
      return () => {
        messageListener = null
      }
    })
    vi.mocked(manager.getOwner).mockResolvedValue(newOwner)
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(manager)
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })
    await controller.openNotebook(uri)

    const result = controller.forceReleaseNotebook(
      createForceReleaseRequest(uri)
    )
    await waitFor(() => expect(lease.release).toHaveBeenCalledTimes(1))
    record.notebook = createNotebook('requester save')
    messageListener?.({ type: 'owner-acquired', record: newOwner })
    finishRelease()

    await expect(result).resolves.toEqual({ status: 'released' })
    expect(
      controller.getNotebookData(uri)?.getCellSnapshot('cell-1')?.value
    ).toBe('requester save')
    expect(controller.getNotebookData(uri)?.isReadOnly()).toBe(true)
    expect(controller.getOpenNotebooks()[0]?.owner).toEqual(newOwner)
  })

  it('reloads the owner save before the requester becomes editable', async () => {
    const uri = 'local://file/takeover'
    const localStore = createFakeLocalNotebooks()
    const record = {
      id: uri,
      name: 'takeover.json',
      remoteId: uri,
      notebook: createNotebook('stale'),
    }
    localStore.records.set(uri, record)
    const owner = {
      notebookUri: uri,
      ownerTabId: 'tab-owner',
      ownerLabel: 'Owner',
      ownerUrl: 'http://localhost/owner',
      ownerStartedAt: new Date().toISOString(),
      epoch: 'epoch-owner',
    }
    const manager = createFakeOwnershipManager()
    vi.mocked(manager.acquire)
      .mockResolvedValueOnce({ status: 'blocked', owner })
      .mockResolvedValueOnce({ status: 'blocked', owner })
      .mockResolvedValueOnce({
        status: 'acquired',
        lease: {
          notebookUri: uri,
          tabId: 'tab-requester',
          epoch: 'epoch-requester',
          release: vi.fn(),
          released: Promise.resolve(),
          isCurrentOwner: vi.fn(async () => true),
        },
      })
    vi.mocked(manager.requestForceRelease).mockResolvedValue({
      status: 'released',
    })
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(manager)
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })
    await controller.openNotebook(uri)
    record.notebook = createNotebook('owner final save')

    const result = await controller.requestWriteAccess(uri)

    expect(manager.requestForceRelease).toHaveBeenCalledTimes(1)
    expect(result.entry.readOnly).toBe(false)
    expect(
      controller.getNotebookData(uri)?.getCellSnapshot('cell-1')?.value
    ).toBe('owner final save')
  })

  it('acquires immediately when stale owner metadata outlives the lock', async () => {
    const uri = 'local://file/stale-owner'
    const localStore = createFakeLocalNotebooks()
    localStore.records.set(uri, {
      id: uri,
      name: 'stale-owner.json',
      remoteId: uri,
      notebook: createNotebook('latest'),
    })
    const owner = {
      notebookUri: uri,
      ownerTabId: 'tab-gone',
      ownerLabel: 'Gone owner',
      ownerUrl: 'http://localhost/gone',
      ownerStartedAt: new Date().toISOString(),
      epoch: 'epoch-gone',
    }
    const manager = createFakeOwnershipManager()
    vi.mocked(manager.acquire)
      .mockResolvedValueOnce({ status: 'blocked', owner })
      .mockResolvedValueOnce({
        status: 'acquired',
        lease: {
          notebookUri: uri,
          tabId: 'tab-requester',
          epoch: 'epoch-requester',
          release: vi.fn(),
          released: Promise.resolve(),
          isCurrentOwner: vi.fn(async () => true),
        },
      })
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(manager)
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })
    await controller.openNotebook(uri)

    const result = await controller.requestWriteAccess(uri)

    expect(result.entry.readOnly).toBe(false)
    expect(manager.requestForceRelease).not.toHaveBeenCalled()
  })

  it('surfaces coordination errors instead of staying pending', async () => {
    const uri = 'local://file/request-error'
    const localStore = createFakeLocalNotebooks()
    localStore.records.set(uri, {
      id: uri,
      name: 'request-error.json',
      remoteId: uri,
      notebook: createNotebook('value'),
    })
    const owner = {
      notebookUri: uri,
      ownerTabId: 'tab-owner',
      ownerLabel: 'Owner',
      ownerUrl: 'http://localhost/owner',
      ownerStartedAt: new Date().toISOString(),
      epoch: 'epoch-owner',
    }
    const manager = createFakeOwnershipManager()
    vi.mocked(manager.acquire).mockResolvedValue({ status: 'blocked', owner })
    vi.mocked(manager.requestForceRelease).mockRejectedValue(
      new Error('IndexedDB unavailable')
    )
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(manager)
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })
    await controller.openNotebook(uri)

    const result = await controller.requestWriteAccess(uri)

    expect(result.entry.writeAccessRequestState).toBe('error')
    expect(result.entry.writeAccessErrorMessage).toContain(
      'IndexedDB unavailable'
    )
  })

  it('reloads a former owner read-only after another tab acquires', async () => {
    const uri = 'local://file/former-owner'
    const localStore = createFakeLocalNotebooks()
    const record = {
      id: uri,
      name: 'former-owner.json',
      remoteId: uri,
      notebook: createNotebook('old'),
    }
    localStore.records.set(uri, record)
    const owner = {
      notebookUri: uri,
      ownerTabId: 'tab-other',
      ownerLabel: 'New owner',
      ownerUrl: 'http://localhost/new-owner',
      ownerStartedAt: new Date().toISOString(),
      epoch: 'epoch-new-owner',
    }
    let messageListener: ((message: NotebookOwnershipMessage) => void) | null =
      null
    const manager = createFakeOwnershipManager({ status: 'blocked', owner })
    vi.mocked(manager.subscribeToMessages).mockImplementation((listener) => {
      messageListener = listener
      return () => {
        messageListener = null
      }
    })
    const controller = getNotebookDataController()
    controller.configureOwnershipManager(manager)
    controller.configureStores({
      localNotebooks: localStore as unknown as LocalNotebooks,
    })
    await controller.openNotebook(uri)
    record.notebook = createNotebook('new writer save')

    messageListener?.({ type: 'owner-acquired', record: owner })

    await waitFor(() => {
      expect(
        controller.getNotebookData(uri)?.getCellSnapshot('cell-1')?.value
      ).toBe('new writer save')
    })
    expect(controller.getNotebookData(uri)?.isReadOnly()).toBe(true)
    expect(controller.getOpenNotebooks()[0]?.owner).toEqual(owner)
  })
})
