/// <reference types="vitest" />
// @vitest-environment node
import { create, toJsonString } from '@bufbuild/protobuf'
import md5 from 'md5'
import { describe, expect, it, vi } from 'vitest'

import {
  clearGoogleDriveRuntime,
  setGoogleDriveBaseUrl,
} from '../lib/googleDriveRuntime'
import { IPYNB_MIME_TYPE } from '../lib/ipynb'
import { encodeIpynbNotebook, encodeRunmeNotebook } from '../lib/notebookFormat'
import { MimeType, parser_pb } from '../runme/client'
import { MemoryConflictDocStorage } from './conflictDocs'
import { DriveNotebookStore } from './drive'
import type { DriveSyncCoordinator } from './driveSyncCoordinator'
import {
  EXCALIDRAW_MIME_TYPE,
  createInitialExcalidrawDocumentJson,
} from './excalidraw'
import { MemoryIpynbShadowStorage } from './ipynbShadows'
import LocalNotebooks, {
  type LocalFileRecord,
  type LocalFolderRecord,
  NotebookConflictChangedError,
} from './local'
import { NotebookStoreItemType } from './notebook'
import { MemoryRevisionDocStorage } from './revisionDocs'

const NOTEBOOK_JSON_WRITE_OPTIONS = {
  emitDefaultValues: true,
} as unknown as Parameters<typeof toJsonString>[2]

function createMockTable<T extends { id: string }>() {
  const store = new Map<string, T>()
  return {
    _store: store,
    get: vi.fn(async (id: string) => store.get(id) ?? undefined),
    put: vi.fn(async (record: T) => {
      store.set(record.id, record)
      return record.id
    }),
    update: vi.fn(async (id: string, changes: Partial<T>) => {
      const existing = store.get(id)
      if (!existing) {
        return 0
      }
      store.set(id, { ...existing, ...changes })
      return 1
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id)
    }),
    where: vi.fn((field: keyof T) => ({
      equals: vi.fn((value: unknown) => ({
        first: vi.fn(async () =>
          [...store.values()].find((record) => record[field] === value)
        ),
      })),
    })),
    filter: vi.fn((predicate: (record: T) => boolean) => ({
      toArray: vi.fn(async () => [...store.values()].filter(predicate)),
      first: vi.fn(async () => [...store.values()].find(predicate)),
    })),
    toArray: vi.fn(async () => [...store.values()]),
  }
}

function createTestDriveSyncCoordinator(): DriveSyncCoordinator {
  const tails = new Map<string, Promise<void>>()
  return {
    async runExclusive<T>(
      localUri: string,
      operation: () => Promise<T>
    ): Promise<T> {
      const previous = tails.get(localUri) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      const tail = previous.then(() => current)
      tails.set(localUri, tail)

      await previous
      try {
        return await operation()
      } finally {
        release()
        if (tails.get(localUri) === tail) {
          tails.delete(localUri)
        }
      }
    },
  }
}

type MockTable<T extends { id: string }> = ReturnType<typeof createMockTable<T>>

function createTestStore(
  driveStore: unknown,
  options: {
    files?: MockTable<LocalFileRecord>
    folders?: MockTable<LocalFolderRecord>
    driveSyncCoordinator?: DriveSyncCoordinator
    ipynbShadowStorage?: MemoryIpynbShadowStorage
  } = {}
) {
  const localStore = Object.create(LocalNotebooks.prototype) as any
  localStore.files = options.files ?? createMockTable<LocalFileRecord>()
  localStore.folders = options.folders ?? createMockTable<LocalFolderRecord>()
  if (
    driveStore &&
    typeof driveStore === 'object' &&
    !('findByCreateOperation' in driveStore)
  ) {
    Object.assign(driveStore, {
      findByCreateOperation: vi.fn(async () => null),
    })
  }
  localStore.driveStore = driveStore
  localStore.driveSyncCoordinator =
    options.driveSyncCoordinator ?? createTestDriveSyncCoordinator()
  localStore.filesystemStore = null
  localStore.inFlightSyncs = new Map()
  localStore.syncListeners = new Map()
  localStore.syncSubjects = new Map()
  localStore.markdownSyncSubjects = new Map()
  localStore.conflictDocStorage = new MemoryConflictDocStorage()
  localStore.revisionDocStorage = new MemoryRevisionDocStorage()
  localStore.ipynbShadowStorage =
    options.ipynbShadowStorage ?? new MemoryIpynbShadowStorage()
  localStore.transaction = async (
    _mode: string,
    _table: unknown,
    operation: () => Promise<unknown>
  ) => operation()
  return localStore as LocalNotebooks
}

function notebookJson(value: string): string {
  return toJsonString(
    parser_pb.NotebookSchema,
    create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value,
        }),
      ],
    }),
    NOTEBOOK_JSON_WRITE_OPTIONS
  )
}

describe('LocalNotebooks pending Drive create', () => {
  it('creates one local mirror across concurrent addFile calls', async () => {
    const store = createTestStore({})
    const remoteUri = 'https://drive.google.com/file/d/concurrent123/view'

    const [first, second] = await Promise.all([
      store.addFile(remoteUri, 'concurrent.json'),
      store.addFile(remoteUri, 'concurrent.json'),
    ])

    expect(second).toBe(first)
    const records = await store.files.toArray()
    expect(records.filter((record) => record.remoteId === remoteUri)).toHaveLength(
      1
    )
  })

  it('initializes an uploaded Drive ipynb as a synced mirror', async () => {
    const remoteUri = 'https://drive.google.com/file/d/created123/view'
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'title-cell',
          kind: parser_pb.CellKind.MARKUP,
          languageId: 'markdown',
          value: '# Created in Drive',
        }),
      ],
    })
    const upstreamContent = encodeIpynbNotebook(notebook).text
    const store = createTestStore({})
    const enqueueMarkdownSync = vi
      .spyOn(store as any, 'enqueueMarkdownSync')
      .mockImplementation(() => undefined)
    const localUri = await store.addFile(remoteUri, 'created.ipynb')

    await store.initializeUploadedDriveNotebook(
      localUri,
      notebook,
      upstreamContent,
      {
        checksum: 'drive-checksum-1',
        revisionId: 'drive-revision-1',
      }
    )

    await expect(store.getSyncState(localUri)).resolves.toMatchObject({
      status: 'synced',
      remoteId: remoteUri,
      lastUpstreamVersion: {
        checksum: 'drive-checksum-1',
        revisionId: 'drive-revision-1',
      },
    })
    await expect(store.load(localUri)).resolves.toMatchObject({
      cells: [
        expect.objectContaining({
          refId: 'title-cell',
          value: '# Created in Drive',
        }),
      ],
    })
    await expect(store.files.get(localUri)).resolves.toMatchObject({
      conflict: undefined,
      lastRemoteChecksum: 'drive-checksum-1',
      ipynbPreservation: {
        upstreamFingerprint: 'drive-checksum-1',
        baselineNotebookChecksum: expect.any(String),
      },
    })
    await expect(store.listDriveBackedFilesNeedingSync()).resolves.toEqual([])
    expect(enqueueMarkdownSync).toHaveBeenCalledWith(localUri)
  })

  it('preserves an existing edited mirror when create is retried', async () => {
    const remoteUri = 'https://drive.google.com/file/d/created123/view'
    const initialNotebook = create(parser_pb.NotebookSchema, { cells: [] })
    const retryNotebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.MARKUP,
          value: '# Remote retry content',
        }),
      ],
    })
    const store = createTestStore({})
    vi.spyOn(store as any, 'enqueueMarkdownSync').mockImplementation(
      () => undefined
    )
    const localUri = await store.addFile(remoteUri, 'created.json')
    await expect(
      store.initializeUploadedDriveNotebook(
        localUri,
        initialNotebook,
        encodeRunmeNotebook(initialNotebook),
        { checksum: 'initial-remote-checksum' }
      )
    ).resolves.toBe(true)

    const editedDoc = notebookJson('# Unsynced local edit')
    await store.files.update(localUri, {
      doc: editedDoc,
      md5Checksum: md5(editedDoc),
      conflict: {
        detectedAt: '2026-08-19T00:00:00.000Z',
        upstreamChecksum: 'other-remote-checksum',
        localChecksumAtDetection: md5(editedDoc),
      },
    })

    await expect(
      store.initializeUploadedDriveNotebook(
        localUri,
        retryNotebook,
        encodeRunmeNotebook(retryNotebook),
        { checksum: 'retry-remote-checksum' }
      )
    ).resolves.toBe(false)

    await expect(store.files.get(localUri)).resolves.toMatchObject({
      doc: editedDoc,
      md5Checksum: md5(editedDoc),
      lastRemoteChecksum: 'initial-remote-checksum',
      conflict: {
        upstreamChecksum: 'other-remote-checksum',
      },
    })
  })

  it('does not overwrite a local edit committed during mirror initialization', async () => {
    const remoteUri = 'https://drive.google.com/file/d/created123/view'
    const uploadedNotebook = create(parser_pb.NotebookSchema, { cells: [] })
    const editedDoc = notebookJson('# Concurrent local edit')
    const store = createTestStore({}) as any
    vi.spyOn(store, 'enqueueMarkdownSync').mockImplementation(() => undefined)
    const localUri = await store.addFile(remoteUri, 'created.json')
    store.transaction = async (
      _mode: string,
      _table: unknown,
      operation: () => Promise<unknown>
    ) => {
      await store.files.update(localUri, {
        doc: editedDoc,
        md5Checksum: md5(editedDoc),
      })
      return operation()
    }

    await expect(
      store.initializeUploadedDriveNotebook(
        localUri,
        uploadedNotebook,
        encodeRunmeNotebook(uploadedNotebook),
        { checksum: 'uploaded-checksum' }
      )
    ).resolves.toBe(false)

    await expect(store.files.get(localUri)).resolves.toMatchObject({
      doc: editedDoc,
      md5Checksum: md5(editedDoc),
      lastRemoteChecksum: '',
      lastSynced: '',
    })
  })

  it('upgrades a legacy Drive placeholder folder to the remote folder name', async () => {
    const parentRemoteUri = 'https://drive.google.com/drive/folders/folder123'
    const driveStore = {
      getMetadata: vi.fn(async () => ({
        uri: parentRemoteUri,
        name: 'runme testing',
        type: NotebookStoreItemType.Folder,
        children: [],
        remoteUri: parentRemoteUri,
        parents: [],
      })),
      list: vi.fn(async () => []),
    }
    const store = createTestStore(driveStore)
    await store.folders.put({
      id: 'local://folder/drive',
      name: 'Drive',
      remoteId: parentRemoteUri,
      children: [],
      lastSynced: '',
    })

    await store.updateFolder(parentRemoteUri)

    expect(driveStore.getMetadata).toHaveBeenCalledWith(parentRemoteUri)
    await expect(
      store.folders.get('local://folder/drive')
    ).resolves.toMatchObject({
      name: 'runme testing',
      remoteId: parentRemoteUri,
    })
  })

  it('attaches a created Drive mirror to an equivalent mounted folder URI', async () => {
    const store = createTestStore({})
    await store.folders.put({
      id: 'local://folder/drive-share-link',
      name: 'Notebooks',
      remoteId:
        'https://drive.google.com/drive/folders/folder123?usp=drive_link',
      children: [],
      lastSynced: '',
    })
    await store.folders.put({
      id: 'local://folder/drive-canonical',
      name: 'Notebooks canonical',
      remoteId: 'https://drive.google.com/drive/folders/folder123',
      children: [],
      lastSynced: '',
    })
    await store.files.put({
      id: 'local://file/created',
      name: 'created.json',
      mimeType: 'application/json',
      remoteId: 'https://drive.google.com/file/d/created123/view',
      lastRemoteChecksum: 'checksum',
      lastSynced: '2026-08-20T00:00:00.000Z',
      doc: '{}',
      md5Checksum: 'checksum',
    })

    await expect(
      store.attachDriveFileToFolder(
        'https://drive.google.com/drive/folders/folder123',
        'local://file/created'
      )
    ).resolves.toBe('local://folder/drive-share-link')

    await expect(
      store.folders.get('local://folder/drive-share-link')
    ).resolves.toMatchObject({
      children: ['local://file/created'],
      provisionalChildren: ['local://file/created'],
    })
    await expect(
      store.folders.get('local://folder/drive-canonical')
    ).resolves.toMatchObject({
      children: ['local://file/created'],
      provisionalChildren: ['local://file/created'],
    })
  })

  it('preserves a direct attachment while its Drive folder is first mounted', async () => {
    const folderUri = 'https://drive.google.com/drive/folders/folder123'
    const driveStore = {
      getMetadata: vi.fn(async () => ({ name: 'Notebooks' })),
      list: vi.fn(async () => []),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/created-before-mount',
      name: 'created.json',
      mimeType: 'application/json',
      remoteId: 'https://drive.google.com/file/d/created123/view',
      lastRemoteChecksum: 'checksum',
      lastSynced: '2026-08-20T00:00:00.000Z',
      doc: '{}',
      md5Checksum: 'checksum',
    })

    const provisionalFolderUri = await store.attachDriveFileToFolder(
      folderUri,
      'local://file/created-before-mount'
    )
    expect(provisionalFolderUri).toMatch(/^local:\/\/folder\//)

    const mountedFolderUri = await store.updateFolder(
      `${folderUri}?usp=drive_link`
    )
    expect(mountedFolderUri).toBe(provisionalFolderUri)
    await expect(store.folders.toArray()).resolves.toHaveLength(1)
    await expect(store.folders.get(mountedFolderUri)).resolves.toMatchObject({
      name: 'Notebooks',
      children: ['local://file/created-before-mount'],
      provisionalChildren: ['local://file/created-before-mount'],
    })
  })

  it('removes stale Drive folder membership before attaching a moved file', async () => {
    const store = createTestStore({})
    await store.files.put({
      id: 'local://file/moved',
      name: 'moved.json',
      remoteId: 'https://drive.google.com/file/d/moved123/view',
      lastRemoteChecksum: 'checksum',
      lastSynced: '',
      doc: '{}',
      md5Checksum: 'checksum',
    })
    await store.folders.put({
      id: 'local://folder/old',
      name: 'Old',
      remoteId: 'https://drive.google.com/drive/folders/old123',
      children: ['local://file/moved'],
      provisionalChildren: ['local://file/moved'],
      lastSynced: '',
    })
    await store.folders.put({
      id: 'local://folder/new',
      name: 'New',
      remoteId: 'https://drive.google.com/drive/folders/new123',
      children: [],
      lastSynced: '',
    })

    await store.attachDriveFileToFolder(
      'https://drive.google.com/drive/folders/new123',
      'local://file/moved'
    )

    await expect(store.folders.get('local://folder/old')).resolves.toMatchObject({
      children: [],
      provisionalChildren: [],
    })
    await expect(store.folders.get('local://folder/new')).resolves.toMatchObject({
      children: ['local://file/moved'],
    })
  })

  it('preserves a direct attachment until a Drive listing confirms it', async () => {
    const folderUri = 'https://drive.google.com/drive/folders/folder123'
    let listedItems: Array<Record<string, unknown>> = []
    const driveStore = {
      list: vi.fn(async () => listedItems),
    }
    const store = createTestStore(driveStore)
    await store.folders.put({
      id: 'local://folder/drive',
      name: 'Notebooks',
      remoteId: folderUri,
      children: [],
      lastSynced: '',
    })
    await store.files.put({
      id: 'local://file/created',
      name: 'created.json',
      mimeType: 'application/json',
      remoteId: 'https://drive.google.com/file/d/created123/view',
      lastRemoteChecksum: 'checksum',
      lastSynced: '2026-08-20T00:00:00.000Z',
      doc: '{}',
      md5Checksum: 'checksum',
    })

    await store.attachDriveFileToFolder(folderUri, 'local://file/created')
    await store.updateFolder(folderUri, 'Notebooks')
    await expect(
      store.folders.get('local://folder/drive')
    ).resolves.toMatchObject({
      children: ['local://file/created'],
      provisionalChildren: ['local://file/created'],
    })

    listedItems = [
      {
        uri: 'https://drive.google.com/file/d/created123/view',
        name: 'created.json',
        type: NotebookStoreItemType.File,
        children: [],
        remoteUri: 'https://drive.google.com/file/d/created123/view',
        parents: [folderUri],
      },
    ]
    await store.updateFolder(folderUri, 'Notebooks')
    await expect(
      store.folders.get('local://folder/drive')
    ).resolves.toMatchObject({
      children: ['local://file/created'],
      provisionalChildren: [],
    })
  })

  it('expires a provisional child that Drive never confirms', async () => {
    const folderUri = 'https://drive.google.com/drive/folders/folder123'
    const driveStore = {
      list: vi.fn(async () => []),
    }
    const store = createTestStore(driveStore)
    await store.folders.put({
      id: 'local://folder/drive',
      name: 'Notebooks',
      remoteId: folderUri,
      children: ['local://file/created'],
      provisionalChildren: ['local://file/created'],
      provisionalChildrenAttachedAt: {
        'local://file/created': Date.now() - 120_000,
      },
      lastSynced: '',
    })
    await store.files.put({
      id: 'local://file/created',
      name: 'created.json',
      mimeType: 'application/json',
      remoteId: 'https://drive.google.com/file/d/created123/view',
      lastRemoteChecksum: 'checksum',
      lastSynced: '2026-08-20T00:00:00.000Z',
      doc: '{}',
      md5Checksum: 'checksum',
    })

    await store.updateFolder(folderUri, 'Notebooks')

    await expect(
      store.folders.get('local://folder/drive')
    ).resolves.toMatchObject({
      children: [],
      provisionalChildren: [],
      provisionalChildrenAttachedAt: {},
    })
  })

  it('preserves concurrent child additions in a mounted Drive folder', async () => {
    const store = createTestStore({})
    const folderUri = 'https://drive.google.com/drive/folders/folder123'
    await store.folders.put({
      id: 'local://folder/drive',
      name: 'Notebooks',
      remoteId: folderUri,
      children: [],
      lastSynced: '',
    })
    await store.files.put({
      id: 'local://file/direct',
      name: 'direct.json',
      mimeType: 'application/json',
      remoteId: 'https://drive.google.com/file/d/direct123/view',
      lastRemoteChecksum: 'checksum',
      lastSynced: '2026-08-20T00:00:00.000Z',
      doc: '{}',
      md5Checksum: 'checksum',
    })

    const [, localItem] = await Promise.all([
      store.attachDriveFileToFolder(folderUri, 'local://file/direct'),
      store.create('local://folder/drive', 'pending.json'),
    ])

    const folder = await store.folders.get('local://folder/drive')
    expect(new Set(folder?.children)).toEqual(
      new Set(['local://file/direct', localItem.uri])
    )
  })

  it('serializes mounted-folder refresh and direct file attachment', async () => {
    let releaseList!: () => void
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve
    })
    const driveStore = {
      list: vi.fn(async () => {
        await listGate
        return []
      }),
    }
    const store = createTestStore(driveStore)
    const folderUri = 'https://drive.google.com/drive/folders/folder123'
    await store.folders.put({
      id: 'local://folder/drive',
      name: 'Notebooks',
      remoteId: folderUri,
      children: [],
      lastSynced: '',
    })
    await store.files.put({
      id: 'local://file/created',
      name: 'created.json',
      mimeType: 'application/json',
      remoteId: 'https://drive.google.com/file/d/created123/view',
      lastRemoteChecksum: 'checksum',
      lastSynced: '2026-08-20T00:00:00.000Z',
      doc: '{}',
      md5Checksum: 'checksum',
    })

    const refresh = store.updateFolder(folderUri, 'Notebooks')
    await vi.waitFor(() => expect(driveStore.list).toHaveBeenCalledTimes(1))
    const attach = store.attachDriveFileToFolder(
      folderUri,
      'local://file/created'
    )
    releaseList()
    await Promise.all([refresh, attach])

    await expect(
      store.folders.get('local://folder/drive')
    ).resolves.toMatchObject({ children: ['local://file/created'] })
  })

  it('creates a Drive-backed folder and attaches it locally', async () => {
    const parentRemoteUri = 'https://drive.google.com/drive/folders/folder123'
    const childRemoteUri = 'https://drive.google.com/drive/folders/child123'
    const driveStore = {
      createFolder: vi.fn(async () => ({
        uri: childRemoteUri,
        name: 'Reports',
        type: NotebookStoreItemType.Folder,
        children: [],
        remoteUri: childRemoteUri,
        parents: [parentRemoteUri],
      })),
    }
    const store = createTestStore(driveStore)
    await store.folders.put({
      id: 'local://folder/drive',
      name: 'Drive',
      remoteId: parentRemoteUri,
      children: [],
      lastSynced: '',
    })

    const item = await store.createFolder('local://folder/drive', 'Reports')

    expect(driveStore.createFolder).toHaveBeenCalledWith(
      parentRemoteUri,
      'Reports'
    )
    expect(item.type).toBe(NotebookStoreItemType.Folder)
    expect(item.remoteUri).toBe(childRemoteUri)
    const record = await store.folders.get(item.uri)
    expect(record).toMatchObject({
      name: 'Reports',
      remoteId: childRemoteUri,
      children: [],
    })
    expect(
      (await store.folders.get('local://folder/drive'))?.children
    ).toContain(item.uri)
  })

  it('moves a Drive-backed folder and updates the local folder tree', async () => {
    const sourceRemoteUri = 'https://drive.google.com/drive/folders/source123'
    const destinationRemoteUri =
      'https://drive.google.com/drive/folders/destination123'
    const itemRemoteUri = 'https://drive.google.com/drive/folders/item123'
    const driveStore = {
      move: vi.fn(async () => ({
        uri: itemRemoteUri,
        name: 'Reports',
        type: NotebookStoreItemType.Folder,
        children: [],
        remoteUri: itemRemoteUri,
        parents: [destinationRemoteUri],
      })),
    }
    const store = createTestStore(driveStore)
    await store.folders.put({
      id: 'local://folder/source',
      name: 'Source',
      remoteId: sourceRemoteUri,
      children: ['local://folder/item'],
      lastSynced: '',
    })
    await store.folders.put({
      id: 'local://folder/destination',
      name: 'Destination',
      remoteId: destinationRemoteUri,
      children: [],
      lastSynced: '',
    })
    await store.folders.put({
      id: 'local://folder/item',
      name: 'Reports',
      remoteId: itemRemoteUri,
      children: [],
      lastSynced: '',
    })

    const item = await store.move(
      'local://folder/item',
      'local://folder/destination'
    )

    expect(driveStore.move).toHaveBeenCalledWith(
      itemRemoteUri,
      sourceRemoteUri,
      destinationRemoteUri
    )
    expect(
      (await store.folders.get('local://folder/source'))?.children
    ).toEqual([])
    expect(
      (await store.folders.get('local://folder/destination'))?.children
    ).toEqual(['local://folder/item'])
    expect(item).toMatchObject({
      uri: 'local://folder/item',
      type: NotebookStoreItemType.Folder,
      parents: ['local://folder/destination'],
    })
  })

  it('moves a notebook markdown sidecar with its Drive-backed file', async () => {
    const sourceRemoteUri = 'https://drive.google.com/drive/folders/source123'
    const destinationRemoteUri =
      'https://drive.google.com/drive/folders/destination123'
    const itemRemoteUri = 'https://drive.google.com/file/d/item123/view'
    const markdownUri = 'https://drive.google.com/file/d/markdown123/view'
    const driveStore = {
      move: vi.fn(async () => ({})),
    }
    const store = createTestStore(driveStore)
    await store.folders.put({
      id: 'local://folder/source',
      name: 'Source',
      remoteId: sourceRemoteUri,
      children: ['local://file/item'],
      lastSynced: '',
    })
    await store.folders.put({
      id: 'local://folder/destination',
      name: 'Destination',
      remoteId: destinationRemoteUri,
      children: [],
      lastSynced: '',
    })
    await store.files.put({
      id: 'local://file/item',
      name: 'notebook.json',
      remoteId: itemRemoteUri,
      markdownUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await store.move('local://file/item', 'local://folder/destination')

    expect(driveStore.move.mock.calls).toEqual([
      [itemRemoteUri, sourceRemoteUri, destinationRemoteUri],
      [markdownUri, sourceRemoteUri, destinationRemoteUri],
    ])
    await expect(store.files.get('local://file/item')).resolves.toMatchObject({
      markdownUri,
    })
  })

  it('recreates the markdown sidecar when its Drive move fails', async () => {
    const sourceRemoteUri = 'https://drive.google.com/drive/folders/source123'
    const destinationRemoteUri =
      'https://drive.google.com/drive/folders/destination123'
    const itemRemoteUri = 'https://drive.google.com/file/d/item123/view'
    const markdownUri = 'https://drive.google.com/file/d/markdown123/view'
    const replacementMarkdownUri =
      'https://drive.google.com/file/d/replacement-markdown123/view'
    const driveStore = {
      move: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('Sidecar move failed')),
      getMetadata: vi.fn(async () => ({
        uri: itemRemoteUri,
        name: 'notebook.json',
        type: NotebookStoreItemType.File,
        children: [],
        parents: [destinationRemoteUri],
      })),
      create: vi.fn(async () => ({ uri: replacementMarkdownUri })),
      saveContent: vi.fn(async () => undefined),
    }
    const store = createTestStore(driveStore)
    await store.folders.put({
      id: 'local://folder/source',
      name: 'Source',
      remoteId: sourceRemoteUri,
      children: ['local://file/item'],
      lastSynced: '',
    })
    await store.folders.put({
      id: 'local://folder/destination',
      name: 'Destination',
      remoteId: destinationRemoteUri,
      children: [],
      lastSynced: '',
    })
    await store.files.put({
      id: 'local://file/item',
      name: 'notebook.json',
      remoteId: itemRemoteUri,
      markdownUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: notebookJson('print("hello")'),
      md5Checksum: '',
    })

    await store.move('local://file/item', 'local://folder/destination')

    expect(driveStore.move).toHaveBeenCalledTimes(2)
    await expect(store.files.get('local://file/item')).resolves.toMatchObject({
      markdownUri: replacementMarkdownUri,
    })
    expect(driveStore.create).toHaveBeenCalledWith(
      destinationRemoteUri,
      'notebook.index.md',
      { createOperationId: expect.any(String) }
    )
    expect(driveStore.saveContent).toHaveBeenCalledWith(
      replacementMarkdownUri,
      expect.stringContaining('print("hello")'),
      'text/markdown'
    )
    expect(
      (await store.folders.get('local://folder/destination'))?.children
    ).toEqual(['local://file/item'])
  })

  it('preserves the local folder tree when a Drive move fails', async () => {
    const sourceRemoteUri = 'https://drive.google.com/drive/folders/source123'
    const destinationRemoteUri =
      'https://drive.google.com/drive/folders/destination123'
    const itemRemoteUri = 'https://drive.google.com/file/d/item123/view'
    const driveStore = {
      move: vi.fn(async () => {
        throw new Error('Google Drive authorization is required.')
      }),
    }
    const store = createTestStore(driveStore)
    await store.folders.put({
      id: 'local://folder/source',
      name: 'Source',
      remoteId: sourceRemoteUri,
      children: ['local://file/item'],
      lastSynced: '',
    })
    await store.folders.put({
      id: 'local://folder/destination',
      name: 'Destination',
      remoteId: destinationRemoteUri,
      children: [],
      lastSynced: '',
    })
    await store.files.put({
      id: 'local://file/item',
      name: 'notebook.json',
      remoteId: itemRemoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await expect(
      store.move('local://file/item', 'local://folder/destination')
    ).rejects.toThrow('Google Drive authorization is required.')

    expect(
      (await store.folders.get('local://folder/source'))?.children
    ).toEqual(['local://file/item'])
    expect(
      (await store.folders.get('local://folder/destination'))?.children
    ).toEqual([])
  })

  it('persists pending upstream parent when Drive create fails', async () => {
    const parentRemoteUri = 'https://drive.google.com/drive/folders/folder123'
    const driveStore = {
      create: vi.fn(async () => {
        throw new Error('Google Drive authorization is required.')
      }),
    }
    const store = createTestStore(driveStore)
    await store.folders.put({
      id: 'local://folder/drive',
      name: 'Drive',
      remoteId: parentRemoteUri,
      children: [],
      lastSynced: '',
    })

    const item = await store.create('local://folder/drive', 'draft.json')

    expect(item.type).toBe(NotebookStoreItemType.File)
    const record = await store.files.get(item.uri)
    expect(record?.remoteId).toBe('')
    expect(record?.parentRemoteIdWhenCreated).toBe(parentRemoteUri)
    expect(
      (await store.folders.get('local://folder/drive'))?.children
    ).toContain(item.uri)
  })

  it('reports pending upstream creation in sync state', async () => {
    const parentRemoteUri = 'https://drive.google.com/drive/folders/folder123'
    const store = createTestStore({})
    await store.files.put({
      id: 'local://file/pending',
      name: 'draft.json',
      remoteId: '',
      parentRemoteIdWhenCreated: parentRemoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await expect(
      store.getSyncState('local://file/pending')
    ).resolves.toMatchObject({
      status: 'pending-upstream-create',
      parentRemoteIdWhenCreated: parentRemoteUri,
    })
  })

  it('lists file sync status rows with local and upstream revisions', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const doc = notebookJson("print('local')")
    const checksum = md5(doc)
    const store = createTestStore({})
    await store.files.put({
      id: 'local://file/synced',
      name: 'synced.json',
      remoteId: remoteUri,
      lastRemoteChecksum: checksum,
      lastSynced: '2026-05-30T00:00:00.000Z',
      lastUpstreamVersion: {
        checksum,
        revisionId: 'revision-1',
      },
      doc,
      md5Checksum: checksum,
    })

    await expect(store.listFileSyncStatuses()).resolves.toEqual([
      {
        localUri: 'local://file/synced',
        title: 'synced.json',
        googleDriveUrl: remoteUri,
        revision: checksum,
        upstreamRevision: 'revision-1',
        lastSynced: '2026-05-30T00:00:00.000Z',
        syncStatus: 'synced',
        lastError: undefined,
      },
    ])
  })

  it('creates the Drive file on sync and clears pending parent', async () => {
    const parentRemoteUri = 'https://drive.google.com/drive/folders/folder123'
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const driveStore = {
      create: vi.fn(async () => ({
        uri: remoteUri,
        name: 'draft.json',
        type: NotebookStoreItemType.File,
        children: [],
        parents: [parentRemoteUri],
      })),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: 'checksum-1',
        headRevisionId: 'revision-1',
      })),
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: 'draft.json',
        type: NotebookStoreItemType.File,
        children: [],
        parents: [parentRemoteUri],
      })),
      save: vi.fn(async () => ({ conflicted: false })),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/pending',
      name: 'draft.json',
      remoteId: '',
      parentRemoteIdWhenCreated: parentRemoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await store.sync('local://file/pending')

    const record = await store.files.get('local://file/pending')
    expect(record?.remoteId).toBe(remoteUri)
    expect(record?.parentRemoteIdWhenCreated).toBeUndefined()
    expect(record?.lastRemoteChecksum).toBe('checksum-1')
    expect(record?.lastUpstreamVersion).toEqual({
      checksum: 'checksum-1',
      revisionId: 'revision-1',
    })
    expect(driveStore.create).toHaveBeenCalledWith(
      parentRemoteUri,
      'draft.json',
      { createOperationId: expect.any(String) }
    )
  })

  it('does not duplicate a pending Drive file if initial metadata recording fails', async () => {
    const parentRemoteUri = 'https://drive.google.com/drive/folders/folder123'
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const driveStore = {
      create: vi.fn(async () => ({
        uri: remoteUri,
        name: 'draft.json',
        type: NotebookStoreItemType.File,
        children: [],
        parents: [parentRemoteUri],
      })),
      getVersionMetadata: vi
        .fn()
        .mockRejectedValueOnce(new Error('metadata unavailable'))
        .mockResolvedValueOnce({
          md5Checksum: 'remote-created',
          headRevisionId: 'revision-2',
        })
        .mockResolvedValueOnce({
          md5Checksum: 'local-saved',
          headRevisionId: 'revision-3',
        }),
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: 'draft.json',
        type: NotebookStoreItemType.File,
        children: [],
        parents: [parentRemoteUri],
      })),
      save: vi.fn(async () => ({ conflicted: false })),
      saveContent: vi.fn(async () => undefined),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/pending',
      name: 'draft.json',
      remoteId: '',
      parentRemoteIdWhenCreated: parentRemoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '{malformed-json',
      md5Checksum: 'local-checksum',
    })

    await store.sync('local://file/pending')

    const record = await store.files.get('local://file/pending')
    expect(record?.remoteId).toBe(remoteUri)
    expect(record?.parentRemoteIdWhenCreated).toBeUndefined()
    expect(record?.lastRemoteChecksum).toBe('local-saved')
    expect(driveStore.create).toHaveBeenCalledTimes(1)
    expect(driveStore.saveContent).toHaveBeenCalledWith(
      remoteUri,
      '{malformed-json',
      'application/json'
    )
  })

  it('creates pending Excalidraw files with raw content and MIME type', async () => {
    const parentRemoteUri = 'https://drive.google.com/drive/folders/folder123'
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const content = createInitialExcalidrawDocumentJson()
    const driveStore = {
      create: vi.fn(),
      createContent: vi.fn(async () => ({
        uri: remoteUri,
        name: 'diagram.excalidraw',
        type: NotebookStoreItemType.File,
        children: [],
        remoteUri,
        mimeType: EXCALIDRAW_MIME_TYPE,
        parents: [parentRemoteUri],
      })),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: 'remote-created',
        headRevisionId: 'revision-1',
      })),
      getMetadata: vi.fn(),
      saveContent: vi.fn(async () => undefined),
    }
    const store = createTestStore(driveStore)
    await store.folders.put({
      id: 'local://folder/drive',
      name: 'Drive',
      remoteId: parentRemoteUri,
      children: [],
      lastSynced: '',
    })

    const item = await store.createContent(
      'local://folder/drive',
      'diagram.excalidraw',
      content,
      EXCALIDRAW_MIME_TYPE
    )
    await store.sync(item.uri)

    expect(driveStore.create).not.toHaveBeenCalled()
    expect(driveStore.createContent).toHaveBeenCalledWith(
      parentRemoteUri,
      'diagram.excalidraw',
      content,
      EXCALIDRAW_MIME_TYPE,
      { createOperationId: expect.any(String) }
    )
    await expect(store.files.get(item.uri)).resolves.toMatchObject({
      remoteId: remoteUri,
      mimeType: EXCALIDRAW_MIME_TYPE,
      doc: content,
      lastRemoteChecksum: 'remote-created',
    })
  })

  it('saves Drive-backed Excalidraw files as raw content without notebook loading', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const content = createInitialExcalidrawDocumentJson()
    const driveStore = {
      getVersionMetadata: vi
        .fn()
        .mockResolvedValueOnce({
          md5Checksum: 'remote-before-save',
          headRevisionId: 'revision-1',
        })
        .mockResolvedValueOnce({
          md5Checksum: 'remote-after-save',
          headRevisionId: 'revision-2',
        }),
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: 'diagram.excalidraw',
        type: NotebookStoreItemType.File,
        children: [],
        remoteUri,
        mimeType: EXCALIDRAW_MIME_TYPE,
        parents: [],
      })),
      load: vi.fn(),
      saveContent: vi.fn(async () => undefined),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/excalidraw',
      name: 'diagram.excalidraw',
      mimeType: EXCALIDRAW_MIME_TYPE,
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await store.saveContent(
      'local://file/excalidraw',
      content,
      EXCALIDRAW_MIME_TYPE
    )
    await store.sync('local://file/excalidraw')

    expect(driveStore.load).not.toHaveBeenCalled()
    expect(driveStore.saveContent).toHaveBeenCalledWith(
      remoteUri,
      content,
      EXCALIDRAW_MIME_TYPE
    )
    await expect(
      store.files.get('local://file/excalidraw')
    ).resolves.toMatchObject({
      doc: content,
      mimeType: EXCALIDRAW_MIME_TYPE,
      lastRemoteChecksum: 'remote-after-save',
    })
  })

  it('preserves a protected file resource key through the real Drive sync path', async () => {
    setGoogleDriveBaseUrl('https://drive.example.test')
    const remoteUri =
      'https://drive.google.com/file/d/file123/view?resourcekey=file-key'
    const content = createInitialExcalidrawDocumentJson()
    let versionRequests = 0
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input))
        expect(url.searchParams.get('resourceKey')).toBe('file-key')

        if (init?.method === 'GET') {
          const fields = url.searchParams.get('fields') ?? ''
          if (fields.includes('md5Checksum')) {
            versionRequests += 1
            return new Response(
              JSON.stringify({
                id: 'file123',
                name: 'diagram.excalidraw',
                mimeType: EXCALIDRAW_MIME_TYPE,
                md5Checksum:
                  versionRequests === 1
                    ? 'remote-before-save'
                    : 'remote-after-save',
                headRevisionId: `revision-${versionRequests}`,
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }
            )
          }
          return new Response(
            JSON.stringify({
              id: 'file123',
              name: 'diagram.excalidraw',
              mimeType: EXCALIDRAW_MIME_TYPE,
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        }

        expect(init?.method).toBe('PATCH')
        if (url.pathname === '/drive/v3/files/file123') {
          return new Response(
            JSON.stringify({
              id: 'file123',
              name: 'diagram.excalidraw',
              mimeType: EXCALIDRAW_MIME_TYPE,
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        }
        expect(url.pathname).toBe('/upload/drive/v3/files/file123')
        expect(init?.body).toBe(content)
        return new Response('', { status: 200 })
      })

    try {
      const store = createTestStore(
        new DriveNotebookStore(async () => 'access-token')
      )
      await store.files.put({
        id: 'local://file/protected-excalidraw',
        name: 'diagram.excalidraw',
        mimeType: EXCALIDRAW_MIME_TYPE,
        remoteId: remoteUri,
        lastRemoteChecksum: 'remote-before-save',
        lastSynced: '',
        doc: content,
        md5Checksum: '',
      })

      await store.sync('local://file/protected-excalidraw')

      expect(fetchMock).toHaveBeenCalledTimes(5)
      await expect(
        store.files.get('local://file/protected-excalidraw')
      ).resolves.toMatchObject({
        remoteId: remoteUri,
        lastRemoteChecksum: 'remote-after-save',
      })
    } finally {
      fetchMock.mockRestore()
      clearGoogleDriveRuntime()
    }
  })

  it('hydrates raw Excalidraw content from Drive into the local mirror', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const content = createInitialExcalidrawDocumentJson()
    const driveStore = {
      loadContent: vi.fn(async () => content),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: 'remote-content',
        headRevisionId: 'revision-1',
      })),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/excalidraw',
      name: 'diagram.excalidraw',
      mimeType: EXCALIDRAW_MIME_TYPE,
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await expect(store.loadContent('local://file/excalidraw')).resolves.toBe(
      content
    )
    expect(driveStore.loadContent).toHaveBeenCalledWith(remoteUri)
    await expect(
      store.files.get('local://file/excalidraw')
    ).resolves.toMatchObject({
      doc: content,
      lastRemoteChecksum: 'remote-content',
    })
  })

  it('serializes overlapping sync calls for the same pending Drive file', async () => {
    const parentRemoteUri = 'https://drive.google.com/drive/folders/folder123'
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    let releaseCreate!: () => void
    let createStarted!: () => void
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve
    })
    const releaseCreatePromise = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const driveStore = {
      create: vi.fn(async () => {
        createStarted()
        await releaseCreatePromise
        return {
          uri: remoteUri,
          name: 'draft.json',
          type: NotebookStoreItemType.File,
          children: [],
          parents: [parentRemoteUri],
        }
      }),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: 'checksum-1',
        headRevisionId: 'revision-1',
      })),
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: 'draft.json',
        type: NotebookStoreItemType.File,
        children: [],
        parents: [parentRemoteUri],
      })),
      save: vi.fn(async () => ({ conflicted: false })),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/pending',
      name: 'draft.json',
      remoteId: '',
      parentRemoteIdWhenCreated: parentRemoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    const firstSync = store.sync('local://file/pending')
    await createStartedPromise
    const secondSync = store.sync('local://file/pending')
    releaseCreate()
    await Promise.all([firstSync, secondSync])

    const record = await store.files.get('local://file/pending')
    expect(record?.remoteId).toBe(remoteUri)
    expect(record?.parentRemoteIdWhenCreated).toBeUndefined()
    expect(driveStore.create).toHaveBeenCalledTimes(1)
  })

  it('serializes pending creates across independent storage instances', async () => {
    const parentRemoteUri = 'https://drive.google.com/drive/folders/folder123'
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const files = createMockTable<LocalFileRecord>()
    const driveSyncCoordinator = createTestDriveSyncCoordinator()
    let releaseCreate!: () => void
    let createStarted!: () => void
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve
    })
    const releaseCreatePromise = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const driveStore = {
      findByCreateOperation: vi.fn(async () => null),
      create: vi.fn(async () => {
        createStarted()
        await releaseCreatePromise
        return {
          uri: remoteUri,
          name: 'draft.json',
          type: NotebookStoreItemType.File,
          children: [],
          parents: [parentRemoteUri],
        }
      }),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: 'checksum-1',
        headRevisionId: 'revision-1',
      })),
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: 'draft.json',
        type: NotebookStoreItemType.File,
        children: [],
        parents: [parentRemoteUri],
      })),
      save: vi.fn(async () => ({ conflicted: false })),
    }
    const firstStore = createTestStore(driveStore, {
      files,
      driveSyncCoordinator,
    })
    const secondStore = createTestStore(driveStore, {
      files,
      driveSyncCoordinator,
    })
    await files.put({
      id: 'local://file/pending',
      name: 'draft.json',
      remoteId: '',
      parentRemoteIdWhenCreated: parentRemoteUri,
      driveCreateOperationId: 'create-operation-1',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    const firstSync = firstStore.sync('local://file/pending')
    await createStartedPromise
    const secondSync = secondStore.sync('local://file/pending')
    releaseCreate()
    await Promise.all([firstSync, secondSync])

    expect(driveStore.create).toHaveBeenCalledTimes(1)
    expect(driveStore.findByCreateOperation).toHaveBeenCalledTimes(1)
    await expect(files.get('local://file/pending')).resolves.toMatchObject({
      remoteId: remoteUri,
      parentRemoteIdWhenCreated: undefined,
      driveCreateOperationId: 'create-operation-1',
    })
  })

  it('adopts a Drive file after a crash before recording its remote id', async () => {
    const parentRemoteUri = 'https://drive.google.com/drive/folders/folder123'
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const operationId = 'create-operation-1'
    const files = createMockTable<LocalFileRecord>()
    const driveSyncCoordinator = createTestDriveSyncCoordinator()
    const createdFile = {
      uri: remoteUri,
      name: 'draft.json',
      type: NotebookStoreItemType.File,
      children: [],
      parents: [parentRemoteUri],
    }
    let wasCreated = false
    const driveStore = {
      findByCreateOperation: vi.fn(async () =>
        wasCreated ? createdFile : null
      ),
      create: vi.fn(async () => {
        wasCreated = true
        return createdFile
      }),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: 'checksum-1',
        headRevisionId: 'revision-1',
      })),
      getMetadata: vi.fn(async () => ({
        ...createdFile,
        uri: remoteUri,
      })),
      save: vi.fn(async () => ({ conflicted: false })),
    }
    const firstStore = createTestStore(driveStore, {
      files,
      driveSyncCoordinator,
    })
    await files.put({
      id: 'local://file/pending',
      name: 'draft.json',
      remoteId: '',
      parentRemoteIdWhenCreated: parentRemoteUri,
      driveCreateOperationId: operationId,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    const update = files.update
    let failRemoteIdWrite = true
    files.update = vi.fn(async (id, changes) => {
      if (failRemoteIdWrite && changes.remoteId === remoteUri) {
        failRemoteIdWrite = false
        throw new Error('simulated tab crash')
      }
      return update(id, changes)
    })

    await expect(firstStore.sync('local://file/pending')).rejects.toThrow(
      'simulated tab crash'
    )

    const restartedStore = createTestStore(driveStore, {
      files,
      driveSyncCoordinator,
    })
    await restartedStore.sync('local://file/pending')

    expect(driveStore.create).toHaveBeenCalledTimes(1)
    expect(driveStore.findByCreateOperation).toHaveBeenCalledTimes(2)
    await expect(files.get('local://file/pending')).resolves.toMatchObject({
      remoteId: remoteUri,
      parentRemoteIdWhenCreated: undefined,
      driveCreateOperationId: operationId,
    })
  })
})

describe('LocalNotebooks ipynb conversion', () => {
  it('migrates cached kind-prefixed identities through the preservation map', async () => {
    const shadowStorage = new MemoryIpynbShadowStorage()
    const shadowText = JSON.stringify({
      cells: [
        {
          cell_type: 'markdown',
          id: 'intro',
          metadata: {},
          source: '# Intro',
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    })
    const shadowRef = await shadowStorage.write(
      'local://file/cached-ipynb',
      shadowText
    )
    const store = createTestStore({}, { ipynbShadowStorage: shadowStorage })
    const cached = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'markup_intro',
          kind: parser_pb.CellKind.MARKUP,
          value: '# Intro',
        }),
      ],
    })
    await store.files.put({
      id: 'local://file/cached-ipynb',
      name: 'cached.ipynb',
      mimeType: IPYNB_MIME_TYPE,
      remoteId: 'local://file/cached-ipynb',
      lastRemoteChecksum: '',
      lastSynced: new Date().toISOString(),
      doc: toJsonString(
        parser_pb.NotebookSchema,
        cached,
        NOTEBOOK_JSON_WRITE_OPTIONS
      ),
      md5Checksum: '',
      ipynbPreservation: {
        upstreamFingerprint: md5(shadowText),
        shadowRef,
        jupyterIdByRunmeRefId: { markup_intro: 'intro' },
        baselineCellHashes: {},
        baselineOutputHashes: {},
      },
    })

    const loaded = await store.load('local://file/cached-ipynb')

    expect(loaded.cells[0]?.refId).toBe('intro')
  })

  it('keeps browser-local ipynb shadows current and accepts raw ipynb updates', async () => {
    const store = createTestStore({})
    await store.folders.put({
      id: 'local://folder/local',
      name: 'Local Notebooks',
      remoteId: 'local://folder/local',
      children: [],
      lastSynced: '',
    })
    const item = await store.create(
      'local://folder/local',
      'browser-smoke.ipynb'
    )
    const notebook = await store.load(item.uri)
    notebook.cells.push(
      create(parser_pb.CellSchema, {
        kind: parser_pb.CellKind.CODE,
        languageId: 'javascript',
        value: 'console.log("from Runme")',
        metadata: { 'runme.dev/runnerName': 'appkernel-js' },
      })
    )

    await store.save(item.uri, notebook)
    await store.sync(item.uri)

    const raw = JSON.parse(await store.loadContent(item.uri))
    expect(raw).toMatchObject({
      nbformat: 4,
      cells: [
        {
          cell_type: 'code',
          source: 'console.log("from Runme")',
        },
      ],
    })
    expect(raw.cells[0].metadata.runme.cell.metadata).toMatchObject({
      'runme.dev/runnerName': 'appkernel-js',
    })

    raw.cells[0].source = 'console.log("from Jupyter")'
    await store.saveContent(
      item.uri,
      `${JSON.stringify(raw, null, 2)}\n`,
      IPYNB_MIME_TYPE
    )
    await expect(store.load(item.uri)).resolves.toMatchObject({
      cells: [
        expect.objectContaining({
          value: 'console.log("from Jupyter")',
          languageId: 'javascript',
        }),
      ],
    })
  })

  it('loads and saves ipynb while preserving Jupyter-only fields in OPFS', async () => {
    const localUri = 'local://file/ipynb'
    const remoteUri = 'https://drive.google.com/file/d/ipynb123/view'
    const source = {
      cells: [
        {
          cell_type: 'code',
          id: 'code-cell',
          metadata: { trusted: true, vendor: { folded: false } },
          execution_count: null,
          source: 'print("before")\n',
          outputs: [],
          attachments: { unexpected_but_preserved: true },
        },
      ],
      metadata: {
        kernelspec: { name: 'python3', language: 'python' },
        colab: { provenance: ['keep-me'] },
      },
      nbformat: 4,
      nbformat_minor: 5,
    }
    const sourceText = `${JSON.stringify(source, null, 2)}\n`
    let savedText = ''
    const driveStore = {
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: 'shared.ipynb',
        type: NotebookStoreItemType.File,
        children: [],
        mimeType: IPYNB_MIME_TYPE,
        parents: [],
      })),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: savedText ? 'remote-2' : 'remote-1',
        headRevisionId: savedText ? 'revision-2' : 'revision-1',
      })),
      loadContent: vi.fn(async () => sourceText),
      saveContent: vi.fn(
        async (_uri: string, content: string, _mimeType: string) => {
          savedText = content
        }
      ),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: localUri,
      name: 'shared.ipynb',
      mimeType: IPYNB_MIME_TYPE,
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await store.sync(localUri)
    const notebook = await store.load(localUri)
    expect(notebook.cells[0]?.value).toBe('print("before")\n')
    expect(
      (await store.files.get(localUri))?.ipynbPreservation?.shadowRef
    ).toEqual(expect.objectContaining({ storage: 'opfs' }))

    notebook.cells[0]!.value = 'print("after")\n'
    await store.save(localUri, notebook)
    await store.sync(localUri)

    expect(driveStore.saveContent).toHaveBeenCalledWith(
      remoteUri,
      expect.any(String),
      IPYNB_MIME_TYPE
    )
    const saved = JSON.parse(savedText)
    expect(saved.cells[0].source).toBe('print("after")\n')
    expect(saved.cells[0].metadata).toMatchObject(source.cells[0].metadata)
    expect(saved.cells[0].attachments).toEqual(source.cells[0].attachments)
    expect(saved.metadata).toMatchObject(source.metadata)
    await expect(store.files.get(localUri)).resolves.toMatchObject({
      lastRemoteChecksum: 'remote-2',
      lastUpstreamVersion: {
        checksum: 'remote-2',
        revisionId: 'revision-2',
      },
    })
  })

  it('accepts remote-only Drive ipynb edits without a false conflict', async () => {
    const localUri = 'local://file/ipynb'
    const remoteUri = 'https://drive.google.com/file/d/ipynb123/view'
    const makeSource = (value: string) =>
      `${JSON.stringify({
        cells: [
          {
            cell_type: 'code',
            id: 'code-cell',
            metadata: { vendor: { folded: false } },
            execution_count: null,
            source: value,
            outputs: [],
          },
        ],
        metadata: { kernelspec: { name: 'python3', language: 'python' } },
        nbformat: 4,
        nbformat_minor: 5,
      })}\n`
    let remoteText = makeSource('print("before")\n')
    let remoteChecksum = 'remote-1'
    const driveStore = {
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: 'shared.ipynb',
        type: NotebookStoreItemType.File,
        children: [],
        mimeType: IPYNB_MIME_TYPE,
        parents: [],
      })),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: remoteChecksum,
        headRevisionId: `${remoteChecksum}-revision`,
      })),
      loadContent: vi.fn(async () => remoteText),
    }
    const shadowStorage = new MemoryIpynbShadowStorage()
    const store = createTestStore(driveStore, {
      ipynbShadowStorage: shadowStorage,
    })
    await store.files.put({
      id: localUri,
      name: 'shared.ipynb',
      mimeType: IPYNB_MIME_TYPE,
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await store.sync(localUri)
    const firstShadow = (await store.files.get(localUri))!.ipynbPreservation!
      .shadowRef

    remoteText = makeSource('print("after")\n')
    remoteChecksum = 'remote-2'
    await store.sync(localUri)

    await expect(store.load(localUri)).resolves.toMatchObject({
      cells: [expect.objectContaining({ value: 'print("after")\n' })],
    })
    const record = await store.files.get(localUri)
    expect(record?.conflict).toBeUndefined()
    expect(record).toMatchObject({
      lastRemoteChecksum: 'remote-2',
      ipynbPreservation: {
        upstreamFingerprint: 'remote-2',
        baselineNotebookChecksum: expect.any(String),
      },
    })
    await expect(store.getSyncState(localUri)).resolves.toMatchObject({
      status: 'synced',
    })
    await expect(shadowStorage.read(firstShadow)).rejects.toThrow(
      'IPYNB shadow not found'
    )
  })

  it('loads uncached Drive ipynb bytes before creating a shadow', async () => {
    const localUri = 'local://file/ipynb'
    const remoteUri = 'https://drive.google.com/file/d/ipynb123/view'
    const sourceText = `${JSON.stringify({
      cells: [
        {
          cell_type: 'markdown',
          id: 'intro',
          metadata: { vendor: { folded: true } },
          source: '# From Drive',
        },
      ],
      metadata: { colab: { provenance: ['drive'] } },
      nbformat: 4,
      nbformat_minor: 5,
    })}\n`
    const driveStore = {
      loadContent: vi.fn(async () => sourceText),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: 'remote-checksum',
        headRevisionId: 'remote-revision',
      })),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: localUri,
      name: 'shared.ipynb',
      mimeType: IPYNB_MIME_TYPE,
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await expect(store.loadContent(localUri)).resolves.toBe(sourceText)
    expect(driveStore.loadContent).toHaveBeenCalledWith(remoteUri)
    await expect(store.load(localUri)).resolves.toMatchObject({
      cells: [expect.objectContaining({ value: '# From Drive' })],
    })
    await expect(store.files.get(localUri)).resolves.toMatchObject({
      lastRemoteChecksum: 'remote-checksum',
      lastUpstreamVersion: {
        checksum: 'remote-checksum',
        revisionId: 'remote-revision',
      },
      ipynbPreservation: {
        upstreamFingerprint: 'remote-checksum',
        baselineNotebookChecksum: expect.any(String),
      },
    })
  })

  it('merges filesystem ipynb changes from the freshly read shadow', async () => {
    const localUri = 'local://file/ipynb'
    const remoteUri = 'fs://workspace/test/file/notebook.ipynb'
    const makeSource = (provenance: string) =>
      `${JSON.stringify({
        cells: [
          {
            cell_type: 'code',
            id: 'code-cell',
            metadata: { vendor: { folded: false } },
            execution_count: null,
            source: 'print("same model")\n',
            outputs: [],
          },
        ],
        metadata: { colab: { provenance: [provenance] } },
        nbformat: 4,
        nbformat_minor: 5,
      })}\n`
    let filesystemText = makeSource('original')
    const filesystemStore = {
      loadContent: vi.fn(async () => filesystemText),
      saveContent: vi.fn(async (_uri: string, content: string) => {
        filesystemText = content
      }),
    }
    const store = createTestStore({})
    store.setFilesystemStore(filesystemStore as never)
    await store.files.put({
      id: localUri,
      name: 'notebook.ipynb',
      mimeType: IPYNB_MIME_TYPE,
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await store.sync(localUri)
    filesystemText = makeSource('external-update')
    await store.sync(localUri)

    expect(filesystemStore.saveContent).toHaveBeenCalled()
    expect(JSON.parse(filesystemText).metadata.colab.provenance).toEqual([
      'external-update',
    ])
  })

  it('rejects renaming a notebook across formats', async () => {
    const store = createTestStore({})
    await store.files.put({
      id: 'local://file/ipynb',
      name: 'shared.ipynb',
      mimeType: IPYNB_MIME_TYPE,
      remoteId: 'local://file/ipynb',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await expect(
      store.rename('local://file/ipynb', 'shared.json')
    ).rejects.toThrow('Changing notebook formats by rename')
  })
})

describe('LocalNotebooks rename', () => {
  it('renames Drive-backed files upstream before updating the local mirror', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const driveStore = {
      rename: vi.fn(async () => ({
        uri: remoteUri,
        name: 'renamed.json',
        type: NotebookStoreItemType.File,
        children: [],
        remoteUri,
        parents: [],
      })),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/drive',
      name: 'original.json',
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })
    await store.folders.put({
      id: 'local://folder/drive',
      name: 'Drive',
      remoteId: 'https://drive.google.com/drive/folders/folder123',
      children: ['local://file/drive'],
      lastSynced: '',
    })

    const result = await store.rename('local://file/drive', 'renamed.json')

    expect(driveStore.rename).toHaveBeenCalledWith(remoteUri, 'renamed.json')
    expect(result).toMatchObject({
      uri: 'local://file/drive',
      name: 'renamed.json',
      remoteUri,
      parents: ['local://folder/drive'],
    })
    expect((await store.files.get('local://file/drive'))?.name).toBe(
      'renamed.json'
    )
  })

  it('renames Drive-backed folders upstream before updating the local mirror', async () => {
    const remoteUri = 'https://drive.google.com/drive/folders/folder123'
    const renamedRemoteUri = 'https://drive.google.com/drive/folders/folder123'
    const driveStore = {
      rename: vi.fn(async () => ({
        uri: renamedRemoteUri,
        name: 'Renamed Folder',
        type: NotebookStoreItemType.Folder,
        children: [],
        remoteUri: renamedRemoteUri,
        parents: [],
      })),
    }
    const store = createTestStore(driveStore)
    await store.folders.put({
      id: 'local://folder/parent',
      name: 'Parent',
      remoteId: 'https://drive.google.com/drive/folders/parent123',
      children: ['local://folder/drive'],
      lastSynced: '',
    })
    await store.folders.put({
      id: 'local://folder/drive',
      name: 'New Folder',
      remoteId: remoteUri,
      children: [],
      lastSynced: '',
    })

    const result = await store.rename('local://folder/drive', 'Renamed Folder')

    expect(driveStore.rename).toHaveBeenCalledWith(remoteUri, 'Renamed Folder')
    expect(result).toMatchObject({
      uri: 'local://folder/drive',
      name: 'Renamed Folder',
      type: NotebookStoreItemType.Folder,
      remoteUri: renamedRemoteUri,
      parents: ['local://folder/parent'],
    })
    expect((await store.folders.get('local://folder/drive'))?.name).toBe(
      'Renamed Folder'
    )
  })

  it('does not update Drive-backed local metadata when the upstream rename fails', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const driveStore = {
      rename: vi.fn(async () => {
        throw new Error('permission denied')
      }),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/drive',
      name: 'original.json',
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await expect(
      store.rename('local://file/drive', 'renamed.json')
    ).rejects.toThrow('permission denied')

    expect((await store.files.get('local://file/drive'))?.name).toBe(
      'original.json'
    )
  })
})

describe('LocalNotebooks moveToTrash', () => {
  it('trashes Drive-backed files upstream and removes the local mirror from its parent', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const driveStore = {
      moveToTrash: vi.fn(async () => ({
        uri: remoteUri,
        name: 'untitled.json',
        type: NotebookStoreItemType.File,
        children: [],
        remoteUri,
        parents: [],
      })),
    }
    const shadowStorage = new MemoryIpynbShadowStorage()
    const shadowRef = await shadowStorage.write(
      'local://file/drive',
      JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      })
    )
    const store = createTestStore(driveStore, {
      ipynbShadowStorage: shadowStorage,
    })
    await store.files.put({
      id: 'local://file/drive',
      name: 'untitled.ipynb',
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
      ipynbPreservation: {
        upstreamFingerprint: '',
        baselineNotebookChecksum: '',
        shadowRef,
        jupyterIdByRunmeRefId: {},
        baselineCellHashes: {},
        baselineOutputHashes: {},
      },
    })
    await store.folders.put({
      id: 'local://folder/drive',
      name: 'Drive',
      remoteId: 'https://drive.google.com/drive/folders/folder123',
      children: ['local://file/drive'],
      lastSynced: '',
    })

    await store.moveToTrash('local://file/drive')

    expect(driveStore.moveToTrash).toHaveBeenCalledWith(remoteUri)
    await expect(store.files.get('local://file/drive')).resolves.toBeUndefined()
    expect(
      (await store.folders.get('local://folder/drive'))?.children
    ).not.toContain('local://file/drive')
    await expect(shadowStorage.read(shadowRef)).rejects.toThrow(
      'IPYNB shadow not found'
    )
  })
})

describe('LocalNotebooks Drive conflict resolution', () => {
  it('loads the current Drive upstream document without creating a conflict', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const upstreamNotebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value: "print('upstream')",
        }),
      ],
    })
    const driveStore = {
      load: vi.fn(async () => upstreamNotebook),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: 'upstream-checksum',
        headRevisionId: 'upstream-revision',
      })),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/drive',
      name: 'notebook.json',
      remoteId: remoteUri,
      lastRemoteChecksum: 'base-checksum',
      lastSynced: '2026-05-01T00:00:00.000Z',
      doc: notebookJson("print('local')"),
      md5Checksum: 'local-checksum',
    })

    await expect(
      store.getDriveUpstreamDoc('local://file/drive')
    ).resolves.toEqual({
      doc: toJsonString(
        parser_pb.NotebookSchema,
        upstreamNotebook,
        NOTEBOOK_JSON_WRITE_OPTIONS
      ),
      version: {
        checksum: 'upstream-checksum',
        revisionId: 'upstream-revision',
      },
    })
    const record = await store.files.get('local://file/drive')
    expect(record?.conflict).toBeUndefined()
    expect(driveStore.load).toHaveBeenCalledWith(remoteUri)
    expect(driveStore.getVersionMetadata).toHaveBeenCalledWith(remoteUri)
  })

  it('stores selected Drive revisions in revision document storage', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const revisionNotebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value: "print('revision')",
        }),
      ],
    })
    const driveStore = {
      loadRevision: vi.fn(async () => revisionNotebook),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/drive',
      name: 'notebook.json',
      remoteId: remoteUri,
      lastRemoteChecksum: 'base-checksum',
      lastSynced: '2026-05-01T00:00:00.000Z',
      doc: notebookJson("print('local')"),
      md5Checksum: 'local-checksum',
    })

    await expect(
      store.getDriveRevisionDoc('local://file/drive', 'revision-1')
    ).resolves.toBe(
      toJsonString(
        parser_pb.NotebookSchema,
        revisionNotebook,
        NOTEBOOK_JSON_WRITE_OPTIONS
      )
    )
    await expect(
      store.getDriveRevisionDoc('local://file/drive', 'revision-1')
    ).resolves.toContain("print('revision')")
    expect(driveStore.loadRevision).toHaveBeenCalledTimes(1)
    expect(driveStore.loadRevision).toHaveBeenCalledWith(
      remoteUri,
      'revision-1'
    )
  })

  it('records a conflict instead of creating a timestamped Drive copy', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const localDoc = notebookJson("print('local')")
    const upstreamNotebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value: "print('upstream')",
        }),
      ],
    })
    const driveStore = {
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: 'notebook.json',
        type: NotebookStoreItemType.File,
        children: [],
        parents: ['https://drive.google.com/drive/folders/folder123'],
      })),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: 'upstream-checksum',
        headRevisionId: 'upstream-revision',
      })),
      load: vi.fn(async () => upstreamNotebook),
      create: vi.fn(),
      save: vi.fn(),
      saveContent: vi.fn(),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/conflict',
      name: 'notebook.json',
      remoteId: remoteUri,
      lastRemoteChecksum: 'base-checksum',
      lastUpstreamVersion: {
        checksum: 'base-checksum',
        revisionId: 'base-revision',
      },
      lastSynced: '2026-05-01T00:00:00.000Z',
      doc: localDoc,
      md5Checksum: 'local-checksum',
    })

    await store.sync('local://file/conflict')

    const record = await store.files.get('local://file/conflict')
    expect(record?.remoteId).toBe(remoteUri)
    expect(record?.name).toBe('notebook.json')
    expect(record?.lastRemoteChecksum).toBe('base-checksum')
    expect(record?.conflict).toMatchObject({
      upstreamChecksum: 'upstream-checksum',
      upstreamVersion: {
        checksum: 'upstream-checksum',
        revisionId: 'upstream-revision',
      },
      localChecksumAtDetection: 'local-checksum',
    })
    expect(record?.conflict?.upstreamDoc).toBeUndefined()
    expect(record?.conflict?.upstreamDocRef).toMatchObject({
      storage: 'opfs',
      sizeBytes: expect.any(Number),
      checksum: expect.any(String),
    })
    await expect(
      store.getConflictUpstreamDoc('local://file/conflict')
    ).resolves.toBe(
      toJsonString(
        parser_pb.NotebookSchema,
        upstreamNotebook,
        NOTEBOOK_JSON_WRITE_OPTIONS
      )
    )
    await expect(
      store.getSyncState('local://file/conflict')
    ).resolves.toMatchObject({
      status: 'conflicted',
      remoteId: remoteUri,
      conflict: {
        upstreamDocSizeBytes: expect.any(Number),
      },
    })
    await expect(store.listDriveBackedFilesNeedingSync()).resolves.toEqual([])
    expect(driveStore.create).not.toHaveBeenCalled()
    expect(driveStore.save).not.toHaveBeenCalled()
    expect(driveStore.saveContent).not.toHaveBeenCalled()
  })

  it('keeps local edits local while a Drive conflict is active', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const store = createTestStore({})
    const nextNotebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value: "print('resolved locally')",
        }),
      ],
    })
    await store.files.put({
      id: 'local://file/conflict',
      name: 'notebook.json',
      remoteId: remoteUri,
      lastRemoteChecksum: 'base-checksum',
      lastSynced: '',
      doc: notebookJson("print('local')"),
      md5Checksum: 'local-checksum',
      conflict: {
        detectedAt: '2026-05-30T00:00:00.000Z',
        upstreamChecksum: 'upstream-checksum',
        upstreamDoc: notebookJson("print('upstream')"),
        localChecksumAtDetection: 'local-checksum',
      },
    })

    await store.save('local://file/conflict', nextNotebook)

    const record = await store.files.get('local://file/conflict')
    expect(record?.doc).toBe(
      toJsonString(
        parser_pb.NotebookSchema,
        nextNotebook,
        NOTEBOOK_JSON_WRITE_OPTIONS
      )
    )
    expect(record?.conflict).toBeTruthy()
    expect((store as any).syncSubjects.size).toBe(0)
    expect((store as any).markdownSyncSubjects.size).toBe(0)
  })

  it('does not expose legacy inline upstreamDoc in passive sync state', async () => {
    const hugeUpstreamDoc = 'x'.repeat(1024 * 1024)
    const store = createTestStore({})
    await store.files.put({
      id: 'local://file/conflict',
      name: 'notebook.json',
      remoteId: 'https://drive.google.com/file/d/file123/view',
      lastRemoteChecksum: 'base-checksum',
      lastSynced: '',
      doc: notebookJson("print('local')"),
      md5Checksum: 'local-checksum',
      conflict: {
        detectedAt: '2026-05-30T00:00:00.000Z',
        upstreamChecksum: 'upstream-checksum',
        upstreamDoc: hugeUpstreamDoc,
        localChecksumAtDetection: 'local-checksum',
      },
    })

    const syncState = await store.getSyncState('local://file/conflict')

    expect(syncState.status).toBe('conflicted')
    expect(syncState.conflict).toMatchObject({
      upstreamChecksum: 'upstream-checksum',
      upstreamDocSizeBytes: hugeUpstreamDoc.length,
    })
    expect(JSON.stringify(syncState)).not.toContain(hugeUpstreamDoc)
  })

  it('migrates a legacy inline upstreamDoc into conflict document storage on demand', async () => {
    const legacyUpstreamDoc = notebookJson("print('legacy upstream')")
    const store = createTestStore({})
    await store.files.put({
      id: 'local://file/conflict',
      name: 'notebook.json',
      remoteId: 'https://drive.google.com/file/d/file123/view',
      lastRemoteChecksum: 'base-checksum',
      lastSynced: '',
      doc: notebookJson("print('local')"),
      md5Checksum: 'local-checksum',
      conflict: {
        detectedAt: '2026-05-30T00:00:00.000Z',
        upstreamChecksum: 'upstream-checksum',
        upstreamDoc: legacyUpstreamDoc,
        localChecksumAtDetection: 'local-checksum',
      },
    })

    await expect(
      store.getConflictUpstreamDoc('local://file/conflict')
    ).resolves.toBe(legacyUpstreamDoc)

    const record = await store.files.get('local://file/conflict')
    expect(record?.conflict?.upstreamDoc).toBeUndefined()
    expect(record?.conflict?.upstreamDocRef).toMatchObject({
      storage: 'opfs',
      checksum: md5(legacyUpstreamDoc),
    })
  })

  it('saves the local version to the original Drive URI and clears conflict', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const localDoc = notebookJson("print('local wins')")
    const savedChecksum = md5(localDoc)
    const driveStore = {
      getVersionMetadata: vi
        .fn()
        .mockResolvedValueOnce({
          md5Checksum: 'upstream-checksum',
          headRevisionId: 'upstream-revision',
        })
        .mockResolvedValueOnce({
          md5Checksum: savedChecksum,
          headRevisionId: 'saved-revision',
        }),
      saveContent: vi.fn(async () => undefined),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/conflict',
      name: 'notebook.json',
      remoteId: remoteUri,
      lastRemoteChecksum: 'base-checksum',
      lastSynced: '',
      doc: localDoc,
      md5Checksum: 'local-checksum',
      conflict: {
        detectedAt: '2026-05-30T00:00:00.000Z',
        upstreamChecksum: 'upstream-checksum',
        upstreamVersion: {
          checksum: 'upstream-checksum',
          revisionId: 'upstream-revision',
        },
        upstreamDoc: notebookJson("print('upstream')"),
        localChecksumAtDetection: 'local-checksum',
      },
    })

    await store.resolveConflictWithLocal('local://file/conflict')

    const record = await store.files.get('local://file/conflict')
    expect(driveStore.saveContent).toHaveBeenCalledWith(
      remoteUri,
      localDoc,
      'application/json'
    )
    expect(record?.remoteId).toBe(remoteUri)
    expect(record?.conflict).toBeUndefined()
    expect(record?.lastRemoteChecksum).toBe(savedChecksum)
    expect(record?.lastUpstreamVersion).toEqual({
      checksum: savedChecksum,
      revisionId: 'saved-revision',
    })
    await expect(
      store.getSyncState('local://file/conflict')
    ).resolves.toMatchObject({
      status: 'synced',
    })
  })

  it('requires force when upstream changed again before saving local version', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const driveStore = {
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: 'newer-upstream-checksum',
        headRevisionId: 'newer-upstream-revision',
      })),
      saveContent: vi.fn(async () => undefined),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/conflict',
      name: 'notebook.json',
      remoteId: remoteUri,
      lastRemoteChecksum: 'base-checksum',
      lastSynced: '',
      doc: notebookJson("print('local')"),
      md5Checksum: 'local-checksum',
      conflict: {
        detectedAt: '2026-05-30T00:00:00.000Z',
        upstreamChecksum: 'upstream-checksum',
        upstreamDoc: notebookJson("print('upstream')"),
        localChecksumAtDetection: 'local-checksum',
      },
    })

    await expect(
      store.resolveConflictWithLocal('local://file/conflict')
    ).rejects.toBeInstanceOf(NotebookConflictChangedError)
    expect(driveStore.saveContent).not.toHaveBeenCalled()

    await store.resolveConflictWithLocal('local://file/conflict', {
      force: true,
    })
    expect(driveStore.saveContent).toHaveBeenCalledWith(
      remoteUri,
      expect.any(String),
      'application/json'
    )
  })

  it('refreshes conflict metadata with the latest Drive head', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const upstreamHeadDoc = notebookJson("print('upstream head')")
    const driveStore = {
      load: vi.fn(async () =>
        create(parser_pb.NotebookSchema, {
          cells: [
            create(parser_pb.CellSchema, {
              kind: parser_pb.CellKind.CODE,
              languageId: 'python',
              value: "print('upstream head')",
            }),
          ],
        })
      ),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: md5(upstreamHeadDoc),
        headRevisionId: 'head-revision',
      })),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/conflict',
      name: 'notebook.json',
      remoteId: remoteUri,
      lastRemoteChecksum: 'base-checksum',
      lastSynced: '',
      doc: notebookJson("print('local')"),
      md5Checksum: '',
      conflict: {
        detectedAt: '2026-05-30T00:00:00.000Z',
        upstreamChecksum: 'old-upstream-checksum',
        upstreamDoc: notebookJson("print('old upstream')"),
        localChecksumAtDetection: 'old-local-checksum',
      },
    })

    const conflict = await store.refreshConflictWithLatestUpstream(
      'local://file/conflict'
    )

    const record = await store.files.get('local://file/conflict')
    expect(driveStore.load).toHaveBeenCalledWith(remoteUri)
    expect(conflict.upstreamChecksum).toBe(md5(upstreamHeadDoc))
    expect(conflict.upstreamVersion).toEqual({
      checksum: md5(upstreamHeadDoc),
      revisionId: 'head-revision',
    })
    expect(conflict.upstreamDoc).toBeUndefined()
    expect(conflict.upstreamDocRef).toMatchObject({
      storage: 'opfs',
      sizeBytes: expect.any(Number),
      checksum: md5(upstreamHeadDoc),
    })
    await expect(
      store.getConflictUpstreamDoc('local://file/conflict')
    ).resolves.toBe(upstreamHeadDoc)
    expect(conflict.localChecksumAtDetection).toBe(md5(record?.doc ?? ''))
    expect(record?.conflict).toEqual(conflict)
  })
})

describe('LocalNotebooks markdown sidecar sync', () => {
  it('serializes notebooks to markdown locally before uploading the sidecar', async () => {
    const markdownUri = 'https://drive.google.com/file/d/sidecar123/view'
    const remoteUri = 'https://drive.google.com/file/d/notebook123/view'
    const driveStore = {
      saveContent: vi.fn(async () => undefined),
    }
    const store = createTestStore(driveStore)
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.MARKUP,
          languageId: 'markdown',
          value: '# Searchable title',
        }),
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value: 'print("hello")',
          outputs: [
            create(parser_pb.CellOutputSchema, {
              items: [
                create(parser_pb.CellOutputItemSchema, {
                  mime: MimeType.VSCodeNotebookStdOut,
                  type: 'Buffer',
                  data: new TextEncoder().encode('hello\n'),
                }),
              ],
            }),
          ],
        }),
      ],
    })

    await store.files.put({
      id: 'local://file/notebook',
      name: 'notebook.json',
      remoteId: remoteUri,
      markdownUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: toJsonString(
        parser_pb.NotebookSchema,
        notebook,
        NOTEBOOK_JSON_WRITE_OPTIONS
      ),
      md5Checksum: '',
    })

    await store.syncMarkdownFile('local://file/notebook')

    expect(driveStore.saveContent).toHaveBeenCalledWith(
      markdownUri,
      [
        '# Searchable title',
        '',
        '```python',
        'print("hello")',
        '```',
        '',
        '```stdout',
        'hello',
        '```',
        '',
      ].join('\n'),
      'text/markdown'
    )
  })

  it('creates one sidecar across independent storage instances', async () => {
    const parentRemoteUri = 'https://drive.google.com/drive/folders/folder123'
    const remoteUri = 'https://drive.google.com/file/d/notebook123/view'
    const markdownUri = 'https://drive.google.com/file/d/sidecar123/view'
    const files = createMockTable<LocalFileRecord>()
    const driveSyncCoordinator = createTestDriveSyncCoordinator()
    let releaseCreate!: () => void
    let createStarted!: () => void
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve
    })
    const releaseCreatePromise = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    const driveStore = {
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: 'notebook.json',
        type: NotebookStoreItemType.File,
        children: [],
        parents: [parentRemoteUri],
      })),
      findByCreateOperation: vi.fn(async () => null),
      create: vi.fn(async () => {
        createStarted()
        await releaseCreatePromise
        return {
          uri: markdownUri,
          name: 'notebook.index.md',
          type: NotebookStoreItemType.File,
          children: [],
          parents: [parentRemoteUri],
        }
      }),
      saveContent: vi.fn(async () => undefined),
    }
    const firstStore = createTestStore(driveStore, {
      files,
      driveSyncCoordinator,
    })
    const secondStore = createTestStore(driveStore, {
      files,
      driveSyncCoordinator,
    })
    await files.put({
      id: 'local://file/notebook',
      name: 'notebook.json',
      remoteId: remoteUri,
      markdownCreateOperationId: 'markdown-operation-1',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: notebookJson('print("hello")'),
      md5Checksum: '',
    })

    const firstSync = firstStore.syncMarkdownFile('local://file/notebook')
    await createStartedPromise
    const secondSync = secondStore.syncMarkdownFile('local://file/notebook')
    releaseCreate()
    await Promise.all([firstSync, secondSync])

    expect(driveStore.create).toHaveBeenCalledTimes(1)
    expect(driveStore.findByCreateOperation).toHaveBeenCalledTimes(1)
    expect(driveStore.saveContent).toHaveBeenCalledTimes(2)
    await expect(files.get('local://file/notebook')).resolves.toMatchObject({
      markdownUri,
      markdownCreateOperationId: 'markdown-operation-1',
    })
  })
})
