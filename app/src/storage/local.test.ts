/// <reference types="vitest" />
// @vitest-environment node
import { create, toJsonString } from '@bufbuild/protobuf'
import md5 from 'md5'
import { describe, expect, it, vi } from 'vitest'

import { MimeType, parser_pb } from '../runme/client'
import { MemoryConflictDocStorage } from './conflictDocs'
import LocalNotebooks, {
  type LocalFileRecord,
  type LocalFolderRecord,
  NotebookConflictChangedError,
} from './local'
import { NotebookStoreItemType } from './notebook'

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

function createTestStore(driveStore: unknown) {
  const localStore = Object.create(LocalNotebooks.prototype) as any
  localStore.files = createMockTable<LocalFileRecord>()
  localStore.folders = createMockTable<LocalFolderRecord>()
  localStore.driveStore = driveStore
  localStore.filesystemStore = null
  localStore.inFlightSyncs = new Map()
  localStore.syncListeners = new Map()
  localStore.syncSubjects = new Map()
  localStore.markdownSyncSubjects = new Map()
  localStore.conflictDocStorage = new MemoryConflictDocStorage()
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
    await expect(store.folders.get('local://folder/drive')).resolves.toMatchObject(
      {
        name: 'runme testing',
        remoteId: parentRemoteUri,
      }
    )
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
      'draft.json'
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
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/drive',
      name: 'untitled.json',
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

    await store.moveToTrash('local://file/drive')

    expect(driveStore.moveToTrash).toHaveBeenCalledWith(remoteUri)
    await expect(store.files.get('local://file/drive')).resolves.toBeUndefined()
    expect(
      (await store.folders.get('local://folder/drive'))?.children
    ).not.toContain('local://file/drive')
  })
})

describe('LocalNotebooks Drive conflict resolution', () => {
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
})
