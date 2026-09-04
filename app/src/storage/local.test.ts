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
import { appLogger } from '../lib/logging/runtime'
import {
  RUNME_OPERATION_LOG_MIME_TYPE,
  convertLegacyNotebookFileToRunme,
  encodeIpynbNotebook,
  encodeRunmeNotebook,
} from '../lib/notebookFormat'
import {
  type NotebookLogHeader,
  createRunmeOperation,
  materializeOperationLog,
  materializedLogToNotebook,
  parseOperationLog,
  serializeOperationLog,
} from '../lib/operationLog'
import { MimeType, RunmeMetadataKey, parser_pb } from '../runme/client'
import { MemoryConflictDocStorage } from './conflictDocs'
import { DriveNotebookStore } from './drive'
import type { DriveSyncCoordinator } from './driveSyncCoordinator'
import {
  EXCALIDRAW_MIME_TYPE,
  createInitialExcalidrawDocumentJson,
} from './excalidraw'
import { MemoryIpynbShadowStorage } from './ipynbShadows'
import LocalNotebooks, {
  DriveSnapshotChangedError,
  LOCAL_FOLDER_URI,
  type LocalFileRecord,
  type LocalFolderRecord,
  NotebookConflictChangedError,
} from './local'
import { NotebookStoreItemType } from './notebook'
import { MemoryOperationLogStorage } from './operationLogs'
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
    operationLogStorage?: MemoryOperationLogStorage
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
  localStore.operationLogStorage =
    options.operationLogStorage ?? new MemoryOperationLogStorage()
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

describe('LocalNotebooks operation-log storage', () => {
  it('initializes a Drive mirror with authoritative OPFS bytes', async () => {
    const operationLogStorage = new MemoryOperationLogStorage()
    const store = createTestStore({}, { operationLogStorage })
    const uri = 'local://file/drive-runme'
    const document = serializeOperationLog(
      {
        record_type: 'runme.notebook',
        format_version: 1,
        notebook_id: 'notebook_drive',
        created_by: 'actor_seed',
        created_at: '2026-09-03T00:00:00Z',
      },
      []
    )
    await store.files.put({
      id: uri,
      name: 'drive.runme',
      remoteId: 'https://drive.google.com/file/d/drive-runme/view',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await expect(
      store.initializeUploadedDriveNotebook(
        uri,
        create(parser_pb.NotebookSchema, { cells: [] }),
        document,
        { checksum: md5(document), revisionId: 'revision-1' }
      )
    ).resolves.toBe(true)

    expect(await store.loadContent(uri)).toBe(document)
    expect(await store.files.get(uri)).toMatchObject({
      doc: '',
      md5Checksum: md5(document),
      operationLogRef: { storage: 'opfs' },
    })
  })

  it('retries first-time Drive mirror hydration until bytes match metadata', async () => {
    const header: NotebookLogHeader = {
      record_type: 'runme.notebook',
      format_version: 1,
      notebook_id: 'notebook_first_hydration_race',
      created_by: 'actor_seed',
      created_at: '2026-09-03T00:00:00Z',
    }
    const remoteOperation = createRunmeOperation({
      actorId: 'actor_remote',
      actorSequence: 1,
      dependencies: [],
      knownOperations: [],
      kind: 'notebook.update',
      payload: { frontmatter: { remote: 'true' }, metadata: {} },
    })
    const staleDocument = serializeOperationLog(header, [])
    const latestDocument = serializeOperationLog(header, [remoteOperation])
    let remoteDocument = staleDocument
    let remoteVersion = {
      md5Checksum: md5(staleDocument),
      headRevisionId: 'revision-1',
      version: '1',
    }
    let loadCount = 0
    const driveStore = {
      getVersionMetadata: vi.fn(async () => remoteVersion),
      loadContent: vi.fn(async () => {
        loadCount += 1
        if (loadCount === 1) {
          remoteDocument = latestDocument
          remoteVersion = {
            md5Checksum: md5(latestDocument),
            headRevisionId: 'revision-2',
            version: '2',
          }
          return staleDocument
        }
        return remoteDocument
      }),
    }
    const operationLogStorage = new MemoryOperationLogStorage()
    const store = createTestStore(driveStore, { operationLogStorage })
    const uri = 'local://file/first-hydration-race'
    await store.files.put({
      id: uri,
      name: 'shared.runme',
      mimeType: 'application/vnd.runme.notebook+jsonl',
      remoteId: 'https://drive.google.com/file/d/first-hydration-race/view',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await store.reconcileDriveNotebook(uri)

    expect(driveStore.loadContent).toHaveBeenCalledTimes(2)
    expect(await store.loadContent(uri)).toBe(latestDocument)
    expect(await store.files.get(uri)).toMatchObject({
      md5Checksum: md5(latestDocument),
      lastRemoteChecksum: md5(latestDocument),
      lastUpstreamVersion: {
        checksum: md5(latestDocument),
        revisionId: 'revision-2',
      },
      lastSyncError: undefined,
    })
  })

  it('keeps local .runme bytes in OPFS storage instead of IndexedDB', async () => {
    const operationLogStorage = new MemoryOperationLogStorage()
    const store = createTestStore({}, { operationLogStorage })
    await store.folders.put({
      id: LOCAL_FOLDER_URI,
      name: 'Local Notebooks',
      remoteId: '',
      children: [],
      lastSynced: '',
    })

    const created = await store.create(LOCAL_FOLDER_URI, 'shared.runme')
    const record = await store.files.get(created.uri)

    expect(record).toMatchObject({
      name: 'shared.runme',
      mimeType: 'application/vnd.runme.notebook+jsonl',
      doc: '',
      operationLogRef: {
        storage: 'opfs',
      },
    })
    expect(await store.loadContent(created.uri)).toContain(
      '"record_type":"runme.notebook"'
    )
    expect((await store.load(created.uri)).cells).toEqual([])
  })

  it('materializes a .runme OPFS snapshot without reading from Drive', async () => {
    const operationLogStorage = new MemoryOperationLogStorage()
    const driveStore = {
      loadContent: vi.fn(async () => {
        throw new Error('Drive should not be read')
      }),
      getVersionMetadata: vi.fn(async () => {
        throw new Error('Drive should not be read')
      }),
    }
    const store = createTestStore(driveStore, { operationLogStorage })
    await store.folders.put({
      id: LOCAL_FOLDER_URI,
      name: 'Local Notebooks',
      remoteId: '',
      children: [],
      lastSynced: '',
    })
    const created = await store.create(LOCAL_FOLDER_URI, 'shared.runme')
    const saveStore = await store.createOperationLogSaveStore(created.uri, {
      actorId: 'actor_test',
    })
    await saveStore.save(
      created.uri,
      create(parser_pb.NotebookSchema, {
        cells: [
          create(parser_pb.CellSchema, {
            refId: 'cell_one',
            kind: parser_pb.CellKind.MARKUP,
            languageId: 'markdown',
            value: 'Local OPFS value',
          }),
        ],
      })
    )
    await store.files.update(created.uri, {
      remoteId: 'https://drive.google.com/file/d/shared/view',
    })

    const snapshot = await store.loadOperationLogSnapshot(created.uri)

    expect(snapshot.cells[0]?.value).toBe('Local OPFS value')
    expect(driveStore.loadContent).not.toHaveBeenCalled()
    expect(driveStore.getVersionMetadata).not.toHaveBeenCalled()
  })

  it('adapts editor snapshots into appended cell operations', async () => {
    const operationLogStorage = new MemoryOperationLogStorage()
    const store = createTestStore({}, { operationLogStorage })
    await store.folders.put({
      id: LOCAL_FOLDER_URI,
      name: 'Local Notebooks',
      remoteId: '',
      children: [],
      lastSynced: '',
    })
    const created = await store.create(LOCAL_FOLDER_URI, 'editable.runme')
    const saveStore = await store.createOperationLogSaveStore(created.uri, {
      actorId: 'actor_test',
    })
    const edited = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'cell_one',
          kind: parser_pb.CellKind.MARKUP,
          languageId: 'markdown',
          value: 'Written through the editor',
        }),
      ],
    })

    await saveStore.save(created.uri, edited)

    expect((await store.load(created.uri)).cells[0]).toMatchObject({
      refId: 'cell_one',
      value: 'Written through the editor',
    })
    const log = parseOperationLog(await store.loadContent(created.uri))
    expect(log.operations.map((operation) => operation.kind)).toEqual([
      'cell.create',
    ])
    expect((await store.files.get(created.uri))?.doc).toBe('')
  })

  it('allocates unique actor sequences for concurrent editor and comment writes', async () => {
    const operationLogStorage = new MemoryOperationLogStorage()
    const store = createTestStore({}, { operationLogStorage })
    await store.folders.put({
      id: LOCAL_FOLDER_URI,
      name: 'Local Notebooks',
      remoteId: '',
      children: [],
      lastSynced: '',
    })
    const created = await store.create(LOCAL_FOLDER_URI, 'shared.runme')
    const saveStore = await store.createOperationLogSaveStore(created.uri, {
      actorId: 'actor_same_session',
    })
    const edited = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'cell_one',
          kind: parser_pb.CellKind.MARKUP,
          languageId: 'markdown',
          value: 'Concurrent edit',
        }),
      ],
    })

    await Promise.all([
      saveStore.save(created.uri, edited),
      store.addOperationLogComment(created.uri, {
        content: 'Concurrent comment',
        anchor: '{}',
        actorId: 'actor_same_session',
      }),
    ])

    const operations = parseOperationLog(
      await store.loadContent(created.uri)
    ).operations
    expect(operations.map((operation) => operation.op_id).sort()).toEqual([
      'actor_same_session:1',
      'actor_same_session:2',
    ])
  })

  it('stores comment threads and replies as append-only operations', async () => {
    const operationLogStorage = new MemoryOperationLogStorage()
    const store = createTestStore({}, { operationLogStorage })
    await store.folders.put({
      id: LOCAL_FOLDER_URI,
      name: 'Local Notebooks',
      remoteId: '',
      children: [],
      lastSynced: '',
    })
    const created = await store.create(LOCAL_FOLDER_URI, 'comments.runme')
    const anchor = JSON.stringify({
      runme: { version: 2, type: 'cell', cellId: 'cell_one' },
    })

    const comment = await store.addOperationLogComment(created.uri, {
      content: 'Please clarify this.',
      anchor,
      actorId: 'actor_comments',
    })
    await store.replyToOperationLogComment(
      created.uri,
      comment.id!,
      'Clarified.',
      { actorId: 'actor_comments' }
    )
    await store.setOperationLogCommentResolved(created.uri, comment.id!, true, {
      actorId: 'actor_comments',
    })

    expect(await store.listOperationLogComments(created.uri)).toEqual([
      expect.objectContaining({
        id: comment.id,
        content: 'Please clarify this.',
        anchor,
        resolved: true,
        replies: [expect.objectContaining({ content: 'Clarified.' })],
      }),
    ])
    expect(
      parseOperationLog(await store.loadContent(created.uri)).operations.map(
        (operation) => operation.kind
      )
    ).toEqual(['comment.add', 'comment.reply', 'thread.set_status'])
  })

  it('loads stale Drive-backed .runme data by merging local and remote operations', async () => {
    const header: NotebookLogHeader = {
      record_type: 'runme.notebook',
      format_version: 1,
      notebook_id: 'notebook_shared',
      created_by: 'actor_seed',
      created_at: '2026-09-03T00:00:00Z',
    }
    const root = createRunmeOperation({
      actorId: 'actor_seed',
      actorSequence: 1,
      dependencies: [],
      knownOperations: [],
      kind: 'notebook.update',
      payload: { frontmatter: {}, metadata: {} },
      createdAt: '2026-09-03T00:00:01Z',
    })
    const alice = createRunmeOperation({
      actorId: 'actor_alice',
      actorSequence: 1,
      dependencies: [root.op_id],
      knownOperations: [root],
      kind: 'cell.create',
      payload: {
        cell_id: 'cell_alice',
        position: [[100, 'actor_alice', 1]],
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: 'Alice',
          metadata: {},
        },
      },
      createdAt: '2026-09-03T00:00:02Z',
    })
    const bob = createRunmeOperation({
      actorId: 'actor_bob',
      actorSequence: 1,
      dependencies: [root.op_id],
      knownOperations: [root],
      kind: 'cell.create',
      payload: {
        cell_id: 'cell_bob',
        position: [[100, 'actor_bob', 1]],
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: 'Bob',
          metadata: {},
        },
      },
      createdAt: '2026-09-03T00:00:02Z',
    })
    // The physical local append order is Bob then Alice, while canonical
    // upstream order is Alice then Bob. They must converge semantically
    // without requiring byte-identical files to report a completed sync.
    const localDocument = serializeOperationLog(header, [root, bob])
    let remoteDocument = serializeOperationLog(header, [root, alice])
    let remoteVersion = {
      md5Checksum: md5(remoteDocument),
      headRevisionId: 'revision-1',
      version: '1',
    }
    const driveStore = {
      getMetadata: vi.fn(async () => ({ name: 'shared.runme' })),
      getVersionMetadata: vi.fn(async () => remoteVersion),
      loadContent: vi.fn(async () => remoteDocument),
      saveContentIfVersion: vi.fn(
        async (
          _uri: string,
          content: string,
          _mimeType: string,
          expected: {
            checksum?: string
            revisionId?: string
            version?: string
          }
        ) => {
          if (
            expected.checksum !== remoteVersion.md5Checksum ||
            expected.revisionId !== remoteVersion.headRevisionId ||
            expected.version !== remoteVersion.version
          ) {
            return false
          }
          remoteDocument = content
          remoteVersion = {
            md5Checksum: md5(content),
            headRevisionId: 'revision-2',
            version: '2',
          }
          return true
        }
      ),
    }
    const operationLogStorage = new MemoryOperationLogStorage()
    const appendOperationLog = vi.spyOn(operationLogStorage, 'append')
    const replaceOperationLog = vi.spyOn(operationLogStorage, 'replace')
    const local = await operationLogStorage.initialize(
      'local://file/shared',
      localDocument
    )
    const store = createTestStore(driveStore, { operationLogStorage })
    await store.files.put({
      id: 'local://file/shared',
      name: 'shared.runme',
      mimeType: 'application/vnd.runme.notebook+jsonl',
      remoteId: 'https://drive.google.com/file/d/shared/view',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: local.checksum,
      operationLogRef: local.ref,
    })

    const loaded = await store.load('local://file/shared')

    const localAfter = await store.loadContent('local://file/shared')
    expect(new Set(loaded.cells.map((cell) => cell.value))).toEqual(
      new Set(['Alice', 'Bob'])
    )
    expect(
      new Set(
        parseOperationLog(localAfter).operations.map(
          (operation) => operation.op_id
        )
      )
    ).toEqual(new Set([root.op_id, alice.op_id, bob.op_id]))
    expect(
      new Set(
        parseOperationLog(remoteDocument).operations.map(
          (operation) => operation.op_id
        )
      )
    ).toEqual(new Set([root.op_id, alice.op_id, bob.op_id]))
    expect(driveStore.saveContentIfVersion).toHaveBeenCalledTimes(1)
    expect((await store.files.get('local://file/shared'))?.doc).toBe('')
    expect(await store.files.get('local://file/shared')).toMatchObject({
      md5Checksum: md5(localAfter),
      lastRemoteChecksum: md5(localAfter),
    })
    expect(appendOperationLog).toHaveBeenCalledTimes(1)
    expect(replaceOperationLog).not.toHaveBeenCalled()
  })

  it('initializes an empty Drive file from the local .runme operation log', async () => {
    const header: NotebookLogHeader = {
      record_type: 'runme.notebook',
      format_version: 1,
      notebook_id: 'notebook_empty_drive',
      created_by: 'actor_seed',
      created_at: '2026-09-03T00:00:00Z',
    }
    const localDocument = serializeOperationLog(header, [])
    let remoteDocument = ''
    let remoteVersion = {
      md5Checksum: md5(remoteDocument),
      headRevisionId: 'revision-1',
      version: '1',
    }
    const driveStore = {
      getMetadata: vi.fn(async () => ({ name: 'shared.runme' })),
      getVersionMetadata: vi.fn(async () => remoteVersion),
      loadContent: vi.fn(async () => remoteDocument),
      saveContentIfVersion: vi.fn(
        async (
          _uri: string,
          content: string,
          _mimeType: string,
          expected: {
            checksum?: string
            revisionId?: string
            version?: string
          }
        ) => {
          expect(expected).toEqual({
            checksum: remoteVersion.md5Checksum,
            revisionId: remoteVersion.headRevisionId,
            version: remoteVersion.version,
          })
          remoteDocument = content
          remoteVersion = {
            md5Checksum: md5(content),
            headRevisionId: 'revision-2',
            version: '2',
          }
          return true
        }
      ),
    }
    const operationLogStorage = new MemoryOperationLogStorage()
    const local = await operationLogStorage.initialize(
      'local://file/empty-drive',
      localDocument
    )
    const store = createTestStore(driveStore, { operationLogStorage })
    await store.files.put({
      id: 'local://file/empty-drive',
      name: 'shared.runme',
      mimeType: 'application/vnd.runme.notebook+jsonl',
      remoteId: 'https://drive.google.com/file/d/empty-drive/view',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: local.checksum,
      operationLogRef: local.ref,
    })

    await store.reconcileDriveNotebook('local://file/empty-drive')

    expect(remoteDocument).toBe(localDocument)
    expect(driveStore.saveContentIfVersion).toHaveBeenCalledOnce()
    expect(await store.files.get('local://file/empty-drive')).toMatchObject({
      lastRemoteChecksum: md5(localDocument),
      lastUpstreamVersion: {
        checksum: md5(localDocument),
        revisionId: 'revision-2',
      },
      lastSyncError: undefined,
    })
  })

  it('creates an operation-log identity when a new Drive mirror is empty', async () => {
    let remoteDocument = ''
    let remoteVersion = {
      md5Checksum: md5(remoteDocument),
      headRevisionId: 'revision-1',
      version: '1',
    }
    const driveStore = {
      getVersionMetadata: vi.fn(async () => remoteVersion),
      loadContent: vi.fn(async () => remoteDocument),
      saveContentIfVersion: vi.fn(
        async (
          _uri: string,
          content: string,
          _mimeType: string,
          expected: {
            checksum?: string
            revisionId?: string
            version?: string
          }
        ) => {
          expect(expected).toEqual({
            checksum: remoteVersion.md5Checksum,
            revisionId: remoteVersion.headRevisionId,
            version: remoteVersion.version,
          })
          remoteDocument = content
          remoteVersion = {
            md5Checksum: md5(content),
            headRevisionId: 'revision-2',
            version: '2',
          }
          return true
        }
      ),
    }
    const store = createTestStore(driveStore)
    const uri = 'local://file/new-empty-drive-mirror'
    await store.files.put({
      id: uri,
      name: 'empty.runme',
      mimeType: 'application/vnd.runme.notebook+jsonl',
      remoteId: 'https://drive.google.com/file/d/new-empty/view',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await store.reconcileDriveNotebook(uri)

    expect(parseOperationLog(remoteDocument).operations).toEqual([])
    expect(remoteDocument.endsWith('\n')).toBe(true)
    expect(await store.loadContent(uri)).toBe(remoteDocument)
    expect(await store.files.get(uri)).toMatchObject({
      lastRemoteChecksum: md5(remoteDocument),
      lastUpstreamVersion: {
        checksum: md5(remoteDocument),
        revisionId: 'revision-2',
      },
      lastSyncError: undefined,
    })
  })

  it('does not overwrite a non-empty malformed Drive operation log', async () => {
    const header: NotebookLogHeader = {
      record_type: 'runme.notebook',
      format_version: 1,
      notebook_id: 'notebook_malformed_drive',
      created_by: 'actor_seed',
      created_at: '2026-09-03T00:00:00Z',
    }
    const localDocument = serializeOperationLog(header, [])
    const remoteDocument = '{}'
    const remoteVersion = {
      md5Checksum: md5(remoteDocument),
      headRevisionId: 'revision-1',
      version: '1',
    }
    const driveStore = {
      getVersionMetadata: vi.fn(async () => remoteVersion),
      loadContent: vi.fn(async () => remoteDocument),
      saveContentIfVersion: vi.fn(),
    }
    const operationLogStorage = new MemoryOperationLogStorage()
    const local = await operationLogStorage.initialize(
      'local://file/malformed-drive',
      localDocument
    )
    const store = createTestStore(driveStore, { operationLogStorage })
    const uri = 'local://file/malformed-drive'
    await store.files.put({
      id: uri,
      name: 'malformed.runme',
      mimeType: 'application/vnd.runme.notebook+jsonl',
      remoteId: 'https://drive.google.com/file/d/malformed/view',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: local.checksum,
      operationLogRef: local.ref,
    })

    await expect(store.reconcileDriveNotebook(uri)).rejects.toThrow(
      'Operation log must end with LF'
    )
    expect(driveStore.saveContentIfVersion).not.toHaveBeenCalled()
  })

  it('rejects stale bytes, then accepts a newer self-consistent Drive snapshot', async () => {
    const header: NotebookLogHeader = {
      record_type: 'runme.notebook',
      format_version: 1,
      notebook_id: 'notebook_drive_race',
      created_by: 'actor_seed',
      created_at: '2026-09-03T00:00:00Z',
    }
    const localOperation = createRunmeOperation({
      actorId: 'actor_local',
      actorSequence: 1,
      dependencies: [],
      knownOperations: [],
      kind: 'notebook.update',
      payload: { frontmatter: { local: 'true' }, metadata: {} },
    })
    const remoteOperation = createRunmeOperation({
      actorId: 'actor_remote',
      actorSequence: 1,
      dependencies: [],
      knownOperations: [],
      kind: 'notebook.update',
      payload: { frontmatter: { remote: 'true' }, metadata: {} },
    })
    const laterRemoteOperation = createRunmeOperation({
      actorId: 'actor_remote',
      actorSequence: 2,
      dependencies: [remoteOperation.op_id],
      knownOperations: [remoteOperation],
      kind: 'notebook.update',
      payload: { frontmatter: { laterRemote: 'true' }, metadata: {} },
    })
    const localDocument = serializeOperationLog(header, [localOperation])
    let remoteDocument = serializeOperationLog(header, [])
    let remoteVersion = {
      md5Checksum: md5(remoteDocument),
      headRevisionId: 'revision-1',
      version: '1',
    }
    let loadCount = 0
    const driveStore = {
      getMetadata: vi.fn(async () => ({ name: 'shared.runme' })),
      getVersionMetadata: vi.fn(async () => remoteVersion),
      loadContent: vi.fn(async () => {
        loadCount += 1
        const downloaded = remoteDocument
        const operations =
          loadCount === 1
            ? [remoteOperation]
            : [remoteOperation, laterRemoteOperation]
        // On the first attempt Drive returns stale bytes alongside newer
        // metadata. On the second, the response bytes and newer metadata agree.
        remoteDocument = serializeOperationLog(header, operations)
        remoteVersion = {
          md5Checksum: md5(remoteDocument),
          headRevisionId: `revision-${loadCount + 1}`,
          version: String(loadCount + 1),
        }
        return loadCount === 1 ? downloaded : remoteDocument
      }),
      saveContentIfVersion: vi.fn(
        async (
          _uri: string,
          content: string,
          _mimeType: string,
          expected: {
            checksum?: string
            revisionId?: string
            version?: string
          }
        ) => {
          expect(expected).toEqual({
            checksum: remoteVersion.md5Checksum,
            revisionId: remoteVersion.headRevisionId,
            version: remoteVersion.version,
          })
          remoteDocument = content
          remoteVersion = {
            md5Checksum: md5(content),
            headRevisionId: 'revision-4',
            version: '4',
          }
          return true
        }
      ),
    }
    const operationLogStorage = new MemoryOperationLogStorage()
    const local = await operationLogStorage.initialize(
      'local://file/drive-race',
      localDocument
    )
    const store = createTestStore(driveStore, { operationLogStorage })
    await store.files.put({
      id: 'local://file/drive-race',
      name: 'shared.runme',
      mimeType: 'application/vnd.runme.notebook+jsonl',
      remoteId: 'https://drive.google.com/file/d/drive-race/view',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: local.checksum,
      operationLogRef: local.ref,
    })

    await store.reconcileDriveNotebook('local://file/drive-race')

    const localAfter = await store.loadContent('local://file/drive-race')
    const expectedOperationIds = new Set([
      localOperation.op_id,
      remoteOperation.op_id,
      laterRemoteOperation.op_id,
    ])
    expect(driveStore.loadContent).toHaveBeenCalledTimes(2)
    expect(driveStore.saveContentIfVersion).toHaveBeenCalledTimes(1)
    expect(
      new Set(
        parseOperationLog(remoteDocument).operations.map(
          (operation) => operation.op_id
        )
      )
    ).toEqual(expectedOperationIds)
    expect(
      new Set(
        parseOperationLog(localAfter).operations.map(
          (operation) => operation.op_id
        )
      )
    ).toEqual(expectedOperationIds)
    expect(await store.files.get('local://file/drive-race')).toMatchObject({
      md5Checksum: md5(localAfter),
      lastRemoteChecksum: md5(localAfter),
      lastSyncError: undefined,
    })
  })

  it('merges every competing operation through the eighth Drive CAS attempt', async () => {
    const header: NotebookLogHeader = {
      record_type: 'runme.notebook',
      format_version: 1,
      notebook_id: 'notebook_drive_contention',
      created_by: 'actor_seed',
      created_at: '2026-09-03T00:00:00Z',
    }
    const localOperation = createRunmeOperation({
      actorId: 'actor_local',
      actorSequence: 1,
      dependencies: [],
      knownOperations: [],
      kind: 'notebook.update',
      payload: { frontmatter: { local: 'true' }, metadata: {} },
    })
    const competingOperations = Array.from({ length: 7 }, (_, index) =>
      createRunmeOperation({
        actorId: `actor_remote_${index + 1}`,
        actorSequence: 1,
        dependencies: [],
        knownOperations: [],
        kind: 'notebook.update',
        payload: {
          frontmatter: { [`remote_${index + 1}`]: 'true' },
          metadata: {},
        },
      })
    )
    const localDocument = serializeOperationLog(header, [localOperation])
    let remoteDocument = serializeOperationLog(header, [])
    let remoteVersion = {
      md5Checksum: md5(remoteDocument),
      headRevisionId: 'revision-1',
      version: '1',
    }
    let collisions = 0
    const driveStore = {
      getMetadata: vi.fn(async () => ({ name: 'shared.runme' })),
      getVersionMetadata: vi.fn(async () => remoteVersion),
      loadContent: vi.fn(async () => remoteDocument),
      saveContentIfVersion: vi.fn(
        async (
          _uri: string,
          content: string,
          _mimeType: string,
          expected: {
            checksum?: string
            revisionId?: string
            version?: string
          }
        ) => {
          expect(expected).toEqual({
            checksum: remoteVersion.md5Checksum,
            revisionId: remoteVersion.headRevisionId,
            version: remoteVersion.version,
          })
          collisions += 1
          if (collisions <= competingOperations.length) {
            remoteDocument = serializeOperationLog(
              header,
              competingOperations.slice(0, collisions)
            )
            remoteVersion = {
              md5Checksum: md5(remoteDocument),
              headRevisionId: `revision-${collisions + 1}`,
              version: String(collisions + 1),
            }
            return false
          }
          remoteDocument = content
          remoteVersion = {
            md5Checksum: md5(content),
            headRevisionId: 'revision-9',
            version: '9',
          }
          return true
        }
      ),
    }
    const operationLogStorage = new MemoryOperationLogStorage()
    const local = await operationLogStorage.initialize(
      'local://file/drive-contention',
      localDocument
    )
    const store = createTestStore(driveStore, { operationLogStorage })
    await store.files.put({
      id: 'local://file/drive-contention',
      name: 'shared.runme',
      mimeType: 'application/vnd.runme.notebook+jsonl',
      remoteId: 'https://drive.google.com/file/d/drive-contention/view',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: local.checksum,
      operationLogRef: local.ref,
    })

    await expect(
      store.reconcileDriveNotebook('local://file/drive-contention')
    ).resolves.toBeUndefined()

    const localAfter = await store.loadContent('local://file/drive-contention')
    const expectedOperationIds = new Set([
      localOperation.op_id,
      ...competingOperations.map((operation) => operation.op_id),
    ])
    expect(driveStore.loadContent).toHaveBeenCalledTimes(8)
    expect(driveStore.saveContentIfVersion).toHaveBeenCalledTimes(8)
    expect(
      new Set(
        parseOperationLog(remoteDocument).operations.map(
          (operation) => operation.op_id
        )
      )
    ).toEqual(expectedOperationIds)
    expect(
      new Set(
        parseOperationLog(localAfter).operations.map(
          (operation) => operation.op_id
        )
      )
    ).toEqual(expectedOperationIds)
  })

  it('reports contention after all eight Drive CAS attempts are exhausted', async () => {
    const header: NotebookLogHeader = {
      record_type: 'runme.notebook',
      format_version: 1,
      notebook_id: 'notebook_drive_exhaustion',
      created_by: 'actor_seed',
      created_at: '2026-09-03T00:00:00Z',
    }
    const localOperation = createRunmeOperation({
      actorId: 'actor_local',
      actorSequence: 1,
      dependencies: [],
      knownOperations: [],
      kind: 'notebook.update',
      payload: { frontmatter: { local: 'true' }, metadata: {} },
    })
    const localDocument = serializeOperationLog(header, [localOperation])
    const remoteDocument = serializeOperationLog(header, [])
    let revision = 1
    const driveStore = {
      getMetadata: vi.fn(async () => ({ name: 'shared.runme' })),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: md5(remoteDocument),
        headRevisionId: `revision-${revision}`,
        version: String(revision),
      })),
      loadContent: vi.fn(async () => remoteDocument),
      saveContentIfVersion: vi.fn(async () => {
        revision += 1
        return false
      }),
    }
    const operationLogStorage = new MemoryOperationLogStorage()
    const local = await operationLogStorage.initialize(
      'local://file/drive-exhaustion',
      localDocument
    )
    const store = createTestStore(driveStore, { operationLogStorage })
    await store.files.put({
      id: 'local://file/drive-exhaustion',
      name: 'shared.runme',
      mimeType: 'application/vnd.runme.notebook+jsonl',
      remoteId: 'https://drive.google.com/file/d/drive-exhaustion/view',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: local.checksum,
      operationLogRef: local.ref,
    })

    await expect(
      store.reconcileDriveNotebook('local://file/drive-exhaustion')
    ).rejects.toThrow(
      'Drive operation log changed during 8 merge attempts for local://file/drive-exhaustion'
    )

    expect(driveStore.loadContent).toHaveBeenCalledTimes(8)
    expect(driveStore.saveContentIfVersion).toHaveBeenCalledTimes(8)
  })

  it('unions concurrent local and filesystem operation logs as raw bytes', async () => {
    const header: NotebookLogHeader = {
      record_type: 'runme.notebook',
      format_version: 1,
      notebook_id: 'notebook_filesystem',
      created_by: 'actor_seed',
      created_at: '2026-09-03T00:00:00Z',
    }
    const root = createRunmeOperation({
      actorId: 'actor_seed',
      actorSequence: 1,
      dependencies: [],
      knownOperations: [],
      kind: 'notebook.update',
      payload: { frontmatter: {}, metadata: {} },
    })
    const localOperation = createRunmeOperation({
      actorId: 'actor_local',
      actorSequence: 1,
      dependencies: [root.op_id],
      knownOperations: [root],
      kind: 'cell.create',
      payload: {
        cell_id: 'cell_local',
        position: [[100, 'actor_local', 1]],
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: 'Local',
          metadata: {},
        },
      },
    })
    const remoteOperation = createRunmeOperation({
      actorId: 'actor_remote',
      actorSequence: 1,
      dependencies: [root.op_id],
      knownOperations: [root],
      kind: 'cell.create',
      payload: {
        cell_id: 'cell_remote',
        position: [[100, 'actor_remote', 1]],
        cell: {
          kind: 'markup',
          language_id: 'markdown',
          value: 'Remote',
          metadata: {},
        },
      },
    })
    const localDocument = serializeOperationLog(header, [root, localOperation])
    let filesystemDocument = serializeOperationLog(header, [
      root,
      remoteOperation,
    ])
    const filesystemStore = {
      loadContent: vi.fn(async () => filesystemDocument),
      saveContent: vi.fn(async (_uri: string, content: string) => {
        filesystemDocument = content
      }),
    }
    const operationLogStorage = new MemoryOperationLogStorage()
    const appendOperationLog = vi.spyOn(operationLogStorage, 'append')
    const replaceOperationLog = vi.spyOn(operationLogStorage, 'replace')
    const local = await operationLogStorage.initialize(
      'local://file/filesystem',
      localDocument
    )
    const store = createTestStore({}, { operationLogStorage })
    store.setFilesystemStore(filesystemStore as never)
    await store.files.put({
      id: 'local://file/filesystem',
      name: 'shared.runme',
      mimeType: 'application/vnd.runme.notebook+jsonl',
      remoteId: 'fs://workspace/test/file/shared.runme',
      lastRemoteChecksum: md5(filesystemDocument),
      lastSynced: '',
      doc: '',
      md5Checksum: local.checksum,
      operationLogRef: local.ref,
    })

    await store.sync('local://file/filesystem')

    const localAfter = await store.loadContent('local://file/filesystem')
    expect(
      parseOperationLog(localAfter).operations.map(
        (operation) => operation.op_id
      )
    ).toEqual([root.op_id, localOperation.op_id, remoteOperation.op_id])
    expect(filesystemDocument).toBe(localAfter)
    expect(filesystemStore.saveContent).toHaveBeenCalledTimes(1)
    expect(appendOperationLog).toHaveBeenCalledTimes(1)
    expect(replaceOperationLog).not.toHaveBeenCalled()
  })
})

describe('LocalNotebooks trusted Drive snapshot import', () => {
  it('initializes a new mirror only after the downloaded version stays stable', async () => {
    const remoteUri = 'https://drive.google.com/file/d/trusted123/view'
    const version = {
      md5Checksum: 'checksum-1',
      headRevisionId: 'revision-1',
      version: '7',
    }
    const driveStore = {
      getVersionMetadata: vi.fn(async () => version),
      loadContent: vi.fn(async () => notebookJson('trusted snapshot')),
    }
    const store = createTestStore(driveStore)

    const localUri = await store.importTrustedDriveSnapshot(
      remoteUri,
      'trusted.json',
      {
        expected: {
          checksum: 'checksum-1',
          revisionId: 'revision-1',
          version: '7',
        },
      }
    )

    const record = await store.files.get(localUri)
    expect(driveStore.loadContent).toHaveBeenCalledTimes(1)
    expect(driveStore.getVersionMetadata).toHaveBeenCalledTimes(2)
    expect(record).toMatchObject({
      remoteId: remoteUri,
      lastRemoteChecksum: 'checksum-1',
      lastUpstreamVersion: {
        checksum: 'checksum-1',
        revisionId: 'revision-1',
      },
    })
    expect(record?.doc).toContain('trusted snapshot')
  })

  it('rejects a changed Drive snapshot without initializing candidate bytes', async () => {
    const remoteUri = 'https://drive.google.com/file/d/changing123/view'
    const driveStore = {
      getVersionMetadata: vi
        .fn()
        .mockResolvedValueOnce({
          md5Checksum: 'checksum-1',
          headRevisionId: 'revision-1',
          version: '7',
        })
        .mockResolvedValueOnce({
          md5Checksum: 'checksum-2',
          headRevisionId: 'revision-2',
          version: '8',
        }),
      loadContent: vi.fn(async () => notebookJson('changed snapshot')),
    }
    const store = createTestStore(driveStore)

    await expect(
      store.importTrustedDriveSnapshot(remoteUri, 'changing.json', {
        expected: {
          checksum: 'checksum-1',
          revisionId: 'revision-1',
          version: '7',
        },
      })
    ).rejects.toBeInstanceOf(DriveSnapshotChangedError)

    const [record] = await store.files.toArray()
    expect(record).toMatchObject({
      remoteId: remoteUri,
      doc: '',
      lastSynced: '',
      lastRemoteChecksum: '',
    })
  })

  it('initializes a trusted zero-byte .runme snapshot through Drive CAS', async () => {
    const remoteUri = 'https://drive.google.com/file/d/empty-trusted/view'
    let remoteDocument = ''
    let version = {
      md5Checksum: md5(remoteDocument),
      headRevisionId: 'revision-1',
      version: '1',
    }
    const driveStore = {
      getVersionMetadata: vi.fn(async () => version),
      loadContent: vi.fn(async () => remoteDocument),
      saveContentIfVersion: vi.fn(
        async (
          _uri: string,
          content: string,
          _mimeType: string,
          expected: {
            checksum?: string
            revisionId?: string
            version?: string
          }
        ) => {
          expect(expected).toEqual({
            checksum: version.md5Checksum,
            revisionId: version.headRevisionId,
            version: version.version,
          })
          remoteDocument = content
          version = {
            md5Checksum: md5(content),
            headRevisionId: 'revision-2',
            version: '2',
          }
          return true
        }
      ),
    }
    const store = createTestStore(driveStore)

    const localUri = await store.importTrustedDriveSnapshot(
      remoteUri,
      'empty.runme',
      {
        expected: {
          checksum: md5(''),
          revisionId: 'revision-1',
          version: '1',
        },
      }
    )

    expect(parseOperationLog(remoteDocument).operations).toEqual([])
    expect(await store.loadContent(localUri)).toBe(remoteDocument)
    expect(await store.files.get(localUri)).toMatchObject({
      remoteId: remoteUri,
      lastRemoteChecksum: md5(remoteDocument),
      lastSyncError: undefined,
    })
  })

  it('rejects an empty trusted .runme import if its validated revision changes', async () => {
    const remoteUri = 'https://drive.google.com/file/d/empty-racing/view'
    const emptyVersion = {
      md5Checksum: md5(''),
      headRevisionId: 'revision-1',
      version: '1',
    }
    const driveStore = {
      getVersionMetadata: vi.fn(async () => emptyVersion),
      loadContent: vi.fn(async () => ''),
      saveContentIfVersion: vi.fn(async () => false),
    }
    const store = createTestStore(driveStore)

    await expect(
      store.importTrustedDriveSnapshot(remoteUri, 'empty.runme', {
        expected: {
          checksum: md5(''),
          revisionId: 'revision-1',
          version: '1',
        },
      })
    ).rejects.toBeInstanceOf(DriveSnapshotChangedError)

    expect(driveStore.saveContentIfVersion).toHaveBeenCalledWith(
      remoteUri,
      expect.stringMatching(/\n$/),
      'application/vnd.runme.notebook+jsonl',
      {
        checksum: md5(''),
        revisionId: 'revision-1',
        version: '1',
      }
    )
    const [record] = await store.files.toArray()
    expect(record).toMatchObject({
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
    })
    expect(record?.operationLogRef).toBeUndefined()
  })

  it('rejects an empty trusted .runme import if its validated Drive version changes', async () => {
    const remoteUri =
      'https://drive.google.com/file/d/empty-version-racing/view'
    let remoteVersion = '1'
    const driveStore = {
      getVersionMetadata: vi.fn(async () => ({ version: remoteVersion })),
      loadContent: vi.fn(async () => ''),
      saveContentIfVersion: vi.fn(
        async (
          _uri: string,
          _content: string,
          _mimeType: string,
          expected: { version?: string }
        ) => {
          remoteVersion = '2'
          return expected.version === remoteVersion
        }
      ),
    }
    const store = createTestStore(driveStore)

    await expect(
      store.importTrustedDriveSnapshot(remoteUri, 'empty.runme', {
        expected: { version: '1' },
      })
    ).rejects.toBeInstanceOf(DriveSnapshotChangedError)

    expect(driveStore.saveContentIfVersion).toHaveBeenCalledWith(
      remoteUri,
      expect.stringMatching(/\n$/),
      'application/vnd.runme.notebook+jsonl',
      { checksum: undefined, revisionId: undefined, version: '1' }
    )
    const [record] = await store.files.toArray()
    expect(record?.operationLogRef).toBeUndefined()
  })
})

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
    expect(
      records.filter((record) => record.remoteId === remoteUri)
    ).toHaveLength(1)
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

    await expect(
      store.folders.get('local://folder/old')
    ).resolves.toMatchObject({
      children: [],
      provisionalChildren: [],
    })
    await expect(
      store.folders.get('local://folder/new')
    ).resolves.toMatchObject({
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
  it('recovers a Drive IPYNB containing Runme JSON instead of showing an empty notebook', async () => {
    const localUri = 'local://file/recover-ipynb'
    const remoteUri = 'https://drive.google.com/file/d/recover123/view'
    const source = create(parser_pb.NotebookSchema, {
      metadata: { 'runme.dev/ipynb': 'true' },
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'title',
          kind: parser_pb.CellKind.MARKUP,
          languageId: 'markdown',
          value: '# Still here',
        }),
      ],
    })
    const malformedIpynb = encodeRunmeNotebook(source)
    const driveStore = {
      getMetadata: vi.fn(async () => ({
        uri: remoteUri,
        name: 'codex_instructions.ipynb',
        type: NotebookStoreItemType.File,
        children: [],
        mimeType: IPYNB_MIME_TYPE,
        parents: [],
      })),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: 'malformed-checksum',
        headRevisionId: 'malformed-revision',
      })),
      loadContent: vi.fn(async () => malformedIpynb),
    }
    const shadowStorage = new MemoryIpynbShadowStorage()
    const store = createTestStore(driveStore, {
      ipynbShadowStorage: shadowStorage,
    })
    await store.files.put({
      id: localUri,
      name: 'codex_instructions.ipynb',
      mimeType: IPYNB_MIME_TYPE,
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })
    vi.spyOn(appLogger, 'warn').mockImplementation(() => null as never)

    const loaded = await store.load(localUri)

    expect(loaded.cells).toHaveLength(1)
    expect(loaded.cells[0]).toMatchObject({
      refId: 'title',
      kind: parser_pb.CellKind.MARKUP,
      value: '# Still here',
    })
    const preservation = (await store.files.get(localUri))?.ipynbPreservation
    expect(preservation).toBeDefined()
    const repaired = JSON.parse(
      await shadowStorage.read(preservation!.shadowRef)
    )
    expect(repaired).toMatchObject({ nbformat: 4, nbformat_minor: 5 })
    expect(repaired.cells).toHaveLength(1)
  })

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

describe('LocalNotebooks legacy notebook conversion', () => {
  it('creates a local .runme sibling without modifying the source', async () => {
    const store = createTestStore({})
    const sourceUri = 'local://file/source-json'
    const sourceDoc = notebookJson('echo source')
    await store.folders.put({
      id: LOCAL_FOLDER_URI,
      name: 'Local Notebooks',
      remoteId: '',
      children: [],
      lastSynced: '',
    })
    await store.files.put({
      id: sourceUri,
      name: 'migration.plan.json',
      remoteId: sourceUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: sourceDoc,
      md5Checksum: md5(sourceDoc),
    })

    const result = await store.convertLegacyNotebookToRunme(
      sourceUri,
      LOCAL_FOLDER_URI
    )

    expect(result.name).toBe('migration.plan.runme')
    expect((await store.files.get(sourceUri))?.doc).toBe(sourceDoc)
    const converted = await store.load(result.uri)
    expect(converted.cells[0]?.value).toBe('echo source')
    expect(
      converted.metadata[RunmeMetadataKey.OriginalGoogleDriveID]
    ).toBeUndefined()
  })

  it('rejects a malformed local source instead of creating an empty notebook', async () => {
    const store = createTestStore({})
    const sourceUri = 'local://file/malformed-json'
    await store.folders.put({
      id: LOCAL_FOLDER_URI,
      name: 'Local Notebooks',
      remoteId: '',
      children: [sourceUri],
      lastSynced: '',
    })
    await store.files.put({
      id: sourceUri,
      name: 'malformed.json',
      remoteId: sourceUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '{not valid json',
      md5Checksum: md5('{not valid json'),
    })

    await expect(
      store.convertLegacyNotebookToRunme(sourceUri, LOCAL_FOLDER_URI)
    ).rejects.toThrow()
    await expect(store.files.toArray()).resolves.toHaveLength(1)
  })

  it('strictly validates raw Drive JSON before normal synchronization', async () => {
    const sourceUri = 'local://file/unrelated-drive-json'
    const sourceRemoteUri =
      'https://drive.google.com/file/d/unrelated-drive-json/view'
    const parentUri = 'local://folder/unrelated-drive-json'
    const rawSource = '{"unrelated":"document"}'
    const driveStore = {
      getMetadata: vi.fn(async () => ({ name: 'unrelated.json' })),
      getVersionMetadata: vi.fn(async () => ({
        md5Checksum: md5(rawSource),
      })),
      load: vi.fn(async () => create(parser_pb.NotebookSchema, { cells: [] })),
      loadContent: vi.fn(async () => rawSource),
    }
    const store = createTestStore(driveStore)
    await store.folders.put({
      id: parentUri,
      name: 'Drive folder',
      remoteId: 'https://drive.google.com/drive/folders/unrelated-drive-json',
      children: [sourceUri],
      lastSynced: '',
    })
    await store.files.put({
      id: sourceUri,
      name: 'unrelated.json',
      remoteId: sourceRemoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    await expect(
      store.convertLegacyNotebookToRunme(sourceUri, parentUri)
    ).rejects.toThrow('Legacy .json file is not a Runme notebook')
    expect(driveStore.load).not.toHaveBeenCalled()
    expect(driveStore.loadContent).toHaveBeenCalledWith(sourceRemoteUri)
    await expect(store.files.toArray()).resolves.toHaveLength(1)
  })

  it('rejects a conflicted Drive IPYNB instead of converting its stale shadow', async () => {
    const sourceUri = 'local://file/conflicted-ipynb'
    const sourceRemoteUri =
      'https://drive.google.com/file/d/conflicted-ipynb/view'
    const parentUri = 'local://folder/conflicted-ipynb'
    const shadowStorage = new MemoryIpynbShadowStorage()
    const staleNotebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'cell-1',
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value: 'echo stale shadow',
        }),
      ],
    })
    const staleIpynb = encodeIpynbNotebook(staleNotebook)
    const shadowRef = await shadowStorage.write(sourceUri, staleIpynb.text)
    const localDoc = notebookJson('echo unsynced local edit')
    const store = createTestStore({}, { ipynbShadowStorage: shadowStorage })
    await store.folders.put({
      id: parentUri,
      name: 'Conflicted Drive folder',
      remoteId: 'https://drive.google.com/drive/folders/conflicted-ipynb',
      children: [sourceUri],
      lastSynced: '',
    })
    await store.files.put({
      id: sourceUri,
      name: 'conflicted.ipynb',
      mimeType: IPYNB_MIME_TYPE,
      remoteId: sourceRemoteUri,
      lastRemoteChecksum: md5(staleIpynb.text),
      lastSynced: new Date().toISOString(),
      conflict: {
        detectedAt: new Date().toISOString(),
        upstreamChecksum: 'upstream-conflict-checksum',
        localChecksumAtDetection: md5(localDoc),
      },
      doc: localDoc,
      md5Checksum: md5(localDoc),
      ipynbPreservation: {
        upstreamFingerprint: md5(staleIpynb.text),
        shadowRef,
        ...staleIpynb.state,
      },
    })

    await expect(
      store.convertLegacyNotebookToRunme(sourceUri, parentUri)
    ).rejects.toThrow('Resolve the sync conflict before converting')
    await expect(store.files.toArray()).resolves.toHaveLength(1)
  })

  it('records the original Drive file ID and waits for the new file sync', async () => {
    const sourceUri = 'local://file/source-drive'
    const sourceRemoteUri =
      'https://drive.google.com/file/d/original-drive-id/view'
    const destinationRemoteUri =
      'https://drive.google.com/file/d/converted-drive-id/view'
    const parentUri = 'local://folder/drive'
    const sourceDoc = notebookJson('echo drive')
    const store = createTestStore({
      loadContent: vi.fn(async () => sourceDoc),
    })
    await store.folders.put({
      id: parentUri,
      name: 'Drive',
      remoteId: 'https://drive.google.com/drive/folders/drive-root',
      children: [sourceUri],
      lastSynced: '',
    })
    await store.files.put({
      id: sourceUri,
      name: 'source.json',
      remoteId: sourceRemoteUri,
      lastRemoteChecksum: md5(sourceDoc),
      lastSynced: new Date().toISOString(),
      doc: sourceDoc,
      md5Checksum: md5(sourceDoc),
    })
    const syncFile = vi
      .spyOn(
        store as unknown as { syncFile(uri: string): Promise<void> },
        'syncFile'
      )
      .mockImplementation(async (uri: string) => {
        if (uri !== sourceUri) {
          await store.files.update(uri, { remoteId: destinationRemoteUri })
        }
      })

    const result = await store.convertLegacyNotebookToRunme(
      sourceUri,
      parentUri
    )

    expect(result).toMatchObject({
      name: 'source.runme',
      remoteUri: destinationRemoteUri,
    })
    expect(syncFile).toHaveBeenCalledWith(sourceUri)
    expect(syncFile).toHaveBeenCalledWith(result.uri)
    const converted = await store.load(result.uri)
    expect(converted.metadata).toMatchObject({
      [RunmeMetadataKey.OriginalGoogleDriveID]: 'original-drive-id',
    })
  })

  it('deduplicates concurrent Drive conversions across equivalent source URLs and folder mounts', async () => {
    const firstSourceUri = 'local://file/concurrent-drive-source-1'
    const secondSourceUri = 'local://file/concurrent-drive-source-2'
    const firstSourceRemoteUri =
      'https://drive.google.com/file/d/concurrent-drive-source/view'
    const secondSourceRemoteUri =
      'https://drive.google.com/open?id=concurrent-drive-source'
    const destinationRemoteUri =
      'https://drive.google.com/file/d/concurrent-drive-target/view'
    const firstParentUri = 'local://folder/concurrent-drive-1'
    const secondParentUri = 'local://folder/concurrent-drive-2'
    const firstParentRemoteUri =
      'https://drive.google.com/drive/folders/concurrent-drive'
    const secondParentRemoteUri =
      'https://drive.google.com/drive/folders/concurrent-drive?resourcekey=alias'
    const sourceDoc = notebookJson('echo concurrent')
    const files = createMockTable<LocalFileRecord>()
    const folders = createMockTable<LocalFolderRecord>()
    const operationLogStorage = new MemoryOperationLogStorage()
    const baseCoordinator = createTestDriveSyncCoordinator()
    let legacyLockRequests = 0
    let notifySecondLockRequest!: () => void
    const secondLockRequested = new Promise<void>((resolve) => {
      notifySecondLockRequest = resolve
    })
    const coordinator: DriveSyncCoordinator = {
      runExclusive: (key, operation) => {
        if (key === 'legacy-conversion:drive:concurrent-drive-source') {
          legacyLockRequests += 1
          if (legacyLockRequests === 2) notifySecondLockRequest()
        }
        return baseCoordinator.runExclusive(key, operation)
      },
    }
    const driveStore = {
      loadContent: vi.fn(async () => sourceDoc),
    }
    const options = {
      files,
      folders,
      driveSyncCoordinator: coordinator,
      operationLogStorage,
    }
    const firstStore = createTestStore(driveStore, options)
    const secondStore = createTestStore(driveStore, options)
    await folders.put({
      id: firstParentUri,
      name: 'Concurrent Drive first mount',
      remoteId: firstParentRemoteUri,
      children: [firstSourceUri],
      lastSynced: '',
    })
    await folders.put({
      id: secondParentUri,
      name: 'Concurrent Drive alias mount',
      remoteId: secondParentRemoteUri,
      children: [secondSourceUri],
      lastSynced: '',
    })
    await files.put({
      id: firstSourceUri,
      name: 'source.json',
      remoteId: firstSourceRemoteUri,
      lastRemoteChecksum: md5(sourceDoc),
      lastSynced: new Date().toISOString(),
      doc: sourceDoc,
      md5Checksum: md5(sourceDoc),
    })
    await files.put({
      id: secondSourceUri,
      name: 'source.json',
      remoteId: secondSourceRemoteUri,
      lastRemoteChecksum: md5(sourceDoc),
      lastSynced: new Date().toISOString(),
      doc: sourceDoc,
      md5Checksum: md5(sourceDoc),
    })
    let releaseFirstTargetSync!: () => void
    const firstTargetSyncReleased = new Promise<void>((resolve) => {
      releaseFirstTargetSync = resolve
    })
    let notifyFirstTargetSync!: () => void
    const firstTargetSyncStarted = new Promise<void>((resolve) => {
      notifyFirstTargetSync = resolve
    })
    vi.spyOn(firstStore, 'syncFile').mockImplementation(async (uri: string) => {
      if (uri === firstSourceUri || uri === secondSourceUri) return
      notifyFirstTargetSync()
      await firstTargetSyncReleased
      await files.update(uri, {
        remoteId: destinationRemoteUri,
        parentRemoteIdWhenCreated: undefined,
      })
    })
    vi.spyOn(secondStore, 'syncFile').mockImplementation(
      async (uri: string) => {
        if (uri === firstSourceUri || uri === secondSourceUri) return
        await files.update(uri, {
          remoteId: destinationRemoteUri,
          parentRemoteIdWhenCreated: undefined,
        })
      }
    )

    const first = firstStore.convertLegacyNotebookToRunme(
      firstSourceUri,
      firstParentUri
    )
    await firstTargetSyncStarted
    const second = secondStore.convertLegacyNotebookToRunme(
      secondSourceUri,
      secondParentUri
    )
    await secondLockRequested
    releaseFirstTargetSync()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(secondResult.uri).toBe(firstResult.uri)
    expect(secondResult.remoteUri).toBe(destinationRemoteUri)
    await expect(files.toArray()).resolves.toHaveLength(3)
  })

  it('syncs a pending Drive source before recording its original file ID', async () => {
    const sourceUri = 'local://file/pending-source-drive'
    const sourceRemoteUri =
      'https://drive.google.com/file/d/pending-source-drive-id/view'
    const destinationRemoteUri =
      'https://drive.google.com/file/d/pending-source-conversion-id/view'
    const parentUri = 'local://folder/pending-source-drive'
    const parentRemoteUri =
      'https://drive.google.com/drive/folders/pending-source-drive'
    const sourceDoc = notebookJson('echo pending source')
    const store = createTestStore({
      loadContent: vi.fn(async () => sourceDoc),
    })
    await store.folders.put({
      id: parentUri,
      name: 'Pending source Drive',
      remoteId: parentRemoteUri,
      children: [sourceUri],
      lastSynced: '',
    })
    await store.files.put({
      id: sourceUri,
      name: 'source.json',
      remoteId: '',
      parentRemoteIdWhenCreated: parentRemoteUri,
      driveCreateOperationId: 'pending-source-create-operation',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: sourceDoc,
      md5Checksum: md5(sourceDoc),
    })
    const syncFile = vi
      .spyOn(store, 'syncFile')
      .mockImplementation(async (uri: string) => {
        if (uri === sourceUri) {
          await store.files.update(uri, {
            remoteId: sourceRemoteUri,
            parentRemoteIdWhenCreated: undefined,
          })
          return
        }
        await store.files.update(uri, { remoteId: destinationRemoteUri })
      })

    const result = await store.convertLegacyNotebookToRunme(
      sourceUri,
      parentUri
    )

    expect(syncFile).toHaveBeenNthCalledWith(1, sourceUri)
    expect(result).toMatchObject({
      name: 'source.runme',
      remoteUri: destinationRemoteUri,
    })
    const converted = await store.load(result.uri)
    expect(converted.metadata).toMatchObject({
      [RunmeMetadataKey.OriginalGoogleDriveID]: 'pending-source-drive-id',
    })
  })

  it('discovers the Drive parent when one is not supplied', async () => {
    const sourceUri = 'local://file/source-drive'
    const sourceRemoteUri =
      'https://drive.google.com/file/d/original-drive-id/view'
    const remoteParentUri =
      'https://drive.google.com/drive/folders/drive-parent-id'
    const parentUri = 'local://folder/drive-parent'
    const destinationRemoteUri =
      'https://drive.google.com/file/d/converted-drive-id/view'
    const driveStore = {
      getMetadata: vi.fn(async () => ({
        uri: sourceRemoteUri,
        name: 'source.ipynb',
        type: NotebookStoreItemType.File,
        children: [],
        parents: [remoteParentUri],
      })),
      loadContent: vi.fn(async () => sourceDoc),
    }
    const store = createTestStore(driveStore)
    const sourceDoc = notebookJson('echo drive')
    await store.files.put({
      id: sourceUri,
      name: 'source.json',
      remoteId: sourceRemoteUri,
      lastRemoteChecksum: md5(sourceDoc),
      lastSynced: new Date().toISOString(),
      doc: sourceDoc,
      md5Checksum: md5(sourceDoc),
    })
    const updateFolder = vi
      .spyOn(store, 'updateFolder')
      .mockImplementation(async (remoteUri: string) => {
        expect(remoteUri).toBe(remoteParentUri)
        await store.folders.put({
          id: parentUri,
          name: 'Drive parent',
          remoteId: remoteParentUri,
          children: [sourceUri],
          lastSynced: '',
        })
        return parentUri
      })
    vi.spyOn(store, 'syncFile').mockImplementation(async (uri: string) => {
      if (uri !== sourceUri) {
        await store.files.update(uri, { remoteId: destinationRemoteUri })
      }
    })

    const result = await store.convertLegacyNotebookToRunme(sourceUri)

    expect(driveStore.getMetadata).toHaveBeenCalledWith(sourceRemoteUri)
    expect(updateFolder).toHaveBeenCalledWith(remoteParentUri)
    expect(result).toMatchObject({
      name: 'source.runme',
      remoteUri: destinationRemoteUri,
    })
  })

  it('reuses a pending Drive conversion after a transient sync failure', async () => {
    const operationLogStorage = new MemoryOperationLogStorage()
    const sourceUri = 'local://file/source-drive-retry'
    const pendingUri = 'local://file/pending-drive-retry'
    const sourceRemoteUri =
      'https://drive.google.com/file/d/original-drive-retry/view'
    const destinationRemoteUri =
      'https://drive.google.com/file/d/converted-drive-retry/view'
    const parentUri = 'local://folder/drive-retry'
    const parentRemoteUri = 'https://drive.google.com/drive/folders/drive-retry'
    const sourceDoc = notebookJson('echo retry')
    const pendingSourceDoc = notebookJson('echo before retry')
    const store = createTestStore(
      { loadContent: vi.fn(async () => sourceDoc) },
      { operationLogStorage }
    )
    const pendingConversion = await convertLegacyNotebookFileToRunme(
      pendingSourceDoc,
      'source.json',
      { originalGoogleDriveId: 'original-drive-retry' }
    )
    const pendingSnapshot = await operationLogStorage.initialize(
      pendingUri,
      pendingConversion.content
    )
    await store.folders.put({
      id: parentUri,
      name: 'Drive retry',
      remoteId: parentRemoteUri,
      children: [sourceUri, pendingUri],
      lastSynced: '',
    })
    await store.files.put({
      id: sourceUri,
      name: 'source.json',
      remoteId: sourceRemoteUri,
      lastRemoteChecksum: md5(sourceDoc),
      lastSynced: new Date().toISOString(),
      doc: sourceDoc,
      md5Checksum: md5(sourceDoc),
    })
    await store.files.put({
      id: pendingUri,
      name: 'source.runme',
      mimeType: RUNME_OPERATION_LOG_MIME_TYPE,
      remoteId: '',
      parentRemoteIdWhenCreated: parentRemoteUri,
      driveCreateOperationId: 'stable-create-operation',
      legacyConversionAttempt: {
        originalGoogleDriveId: 'original-drive-retry',
        sourceChecksum: md5(pendingSourceDoc),
      },
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: pendingSnapshot.checksum,
      operationLogRef: pendingSnapshot.ref,
    })
    const syncFile = vi
      .spyOn(store, 'syncFile')
      .mockImplementation(async (uri: string) => {
        if (uri === sourceUri) {
          return
        }
        expect(uri).toBe(pendingUri)
        await store.files.update(uri, {
          remoteId: destinationRemoteUri,
          parentRemoteIdWhenCreated: undefined,
        })
      })

    const result = await store.convertLegacyNotebookToRunme(
      sourceUri,
      parentUri
    )

    expect(result).toMatchObject({
      uri: pendingUri,
      name: 'source.runme',
      remoteUri: destinationRemoteUri,
    })
    expect(syncFile).toHaveBeenCalledWith(pendingUri)
    expect((await store.load(pendingUri)).cells[0]?.value).toBe('echo retry')
    expect(
      (await store.files.get(pendingUri))?.legacyConversionAttempt
    ).toMatchObject({
      originalGoogleDriveId: 'original-drive-retry',
      sourceChecksum: md5(sourceDoc),
      completedAt: expect.any(String),
    })
    await expect(store.files.toArray()).resolves.toHaveLength(2)
  })

  it('resumes an uploaded Drive conversion before its completion marker is written', async () => {
    const operationLogStorage = new MemoryOperationLogStorage()
    const sourceUri = 'local://file/source-drive-post-create'
    const conversionUri = 'local://file/conversion-drive-post-create'
    const sourceRemoteUri =
      'https://drive.google.com/file/d/original-drive-post-create/view'
    const conversionRemoteUri =
      'https://drive.google.com/file/d/conversion-drive-post-create/view'
    const parentUri = 'local://folder/drive-post-create'
    const parentRemoteUri =
      'https://drive.google.com/drive/folders/drive-post-create'
    const sourceDoc = notebookJson('echo after post create failure')
    const conversionSourceDoc = notebookJson('echo before post create failure')
    const conversion = await convertLegacyNotebookFileToRunme(
      conversionSourceDoc,
      'source.json',
      { originalGoogleDriveId: 'original-drive-post-create' }
    )
    let remoteContent = conversion.content
    let remoteVersion = {
      md5Checksum: md5(remoteContent),
      headRevisionId: 'conversion-revision-1',
      version: '1',
    }
    const driveStore = {
      getVersionMetadata: vi.fn(async () => remoteVersion),
      loadContent: vi.fn(async (uri: string) =>
        uri === sourceRemoteUri ? sourceDoc : remoteContent
      ),
      saveContentIfVersion: vi.fn(async (_uri: string, content: string) => {
        remoteContent = content
        remoteVersion = {
          md5Checksum: md5(content),
          headRevisionId: 'conversion-revision-2',
          version: '2',
        }
        return true
      }),
    }
    const store = createTestStore(driveStore, { operationLogStorage })
    const conversionSnapshot = await operationLogStorage.initialize(
      conversionUri,
      conversion.content
    )
    await store.folders.put({
      id: parentUri,
      name: 'Drive post-create',
      remoteId: parentRemoteUri,
      children: [sourceUri, conversionUri],
      lastSynced: '',
    })
    await store.files.put({
      id: sourceUri,
      name: 'source.json',
      remoteId: sourceRemoteUri,
      lastRemoteChecksum: md5(sourceDoc),
      lastSynced: new Date().toISOString(),
      doc: sourceDoc,
      md5Checksum: md5(sourceDoc),
    })
    await store.files.put({
      id: conversionUri,
      name: 'source.runme',
      mimeType: RUNME_OPERATION_LOG_MIME_TYPE,
      remoteId: conversionRemoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      legacyConversionAttempt: {
        originalGoogleDriveId: 'original-drive-post-create',
        sourceChecksum: md5(conversionSourceDoc),
      },
      doc: '',
      md5Checksum: conversionSnapshot.checksum,
      operationLogRef: conversionSnapshot.ref,
    })
    const syncFileImplementation = store.syncFile.bind(store)
    const syncFile = vi
      .spyOn(store, 'syncFile')
      .mockImplementation(async (uri: string) => {
        if (uri === sourceUri) return
        await syncFileImplementation(uri)
      })

    const result = await store.convertLegacyNotebookToRunme(
      sourceUri,
      parentUri
    )

    expect(result).toMatchObject({
      uri: conversionUri,
      name: 'source.runme',
      remoteUri: conversionRemoteUri,
    })
    expect(syncFile).toHaveBeenCalledWith(conversionUri)
    const refreshedLog = parseOperationLog(
      await store.loadContent(conversionUri)
    )
    expect(refreshedLog.header).toEqual(
      parseOperationLog(conversion.content).header
    )
    const uploadedBefore = parseOperationLog(conversion.content)
    const uploadedAfter = parseOperationLog(remoteContent)
    expect(
      uploadedAfter.operations.slice(0, uploadedBefore.operations.length)
    ).toEqual(uploadedBefore.operations)
    expect(
      new Set(uploadedAfter.operations.map((operation) => operation.op_id)).size
    ).toBe(uploadedAfter.operations.length)
    expect(
      materializedLogToNotebook(
        materializeOperationLog(uploadedAfter.operations)
      ).cells[0]?.value
    ).toBe('echo after post create failure')
    expect(driveStore.saveContentIfVersion).toHaveBeenCalledOnce()
    expect((await store.load(conversionUri)).cells[0]?.value).toBe(
      'echo after post create failure'
    )
    expect(
      (await store.files.get(conversionUri))?.legacyConversionAttempt
    ).toMatchObject({
      originalGoogleDriveId: 'original-drive-post-create',
      sourceChecksum: md5(sourceDoc),
      completedAt: expect.any(String),
    })
    await expect(store.files.toArray()).resolves.toHaveLength(2)
  })

  it('does not reuse an older conversion with an unrelated sync error', async () => {
    const operationLogStorage = new MemoryOperationLogStorage()
    const sourceUri = 'local://file/source-drive-new-attempt'
    const oldConversionUri = 'local://file/old-drive-conversion'
    const sourceRemoteUri =
      'https://drive.google.com/file/d/original-drive-new-attempt/view'
    const oldConversionRemoteUri =
      'https://drive.google.com/file/d/old-drive-conversion/view'
    const newConversionRemoteUri =
      'https://drive.google.com/file/d/new-drive-conversion/view'
    const parentUri = 'local://folder/drive-new-attempt'
    const parentRemoteUri =
      'https://drive.google.com/drive/folders/drive-new-attempt'
    const sourceDoc = notebookJson('echo new attempt')
    const store = createTestStore(
      { loadContent: vi.fn(async () => sourceDoc) },
      { operationLogStorage }
    )
    const oldConversion = await convertLegacyNotebookFileToRunme(
      sourceDoc,
      'source.json',
      { originalGoogleDriveId: 'original-drive-new-attempt' }
    )
    const oldSnapshot = await operationLogStorage.initialize(
      oldConversionUri,
      oldConversion.content
    )
    await store.folders.put({
      id: parentUri,
      name: 'Drive new attempt',
      remoteId: parentRemoteUri,
      children: [sourceUri, oldConversionUri],
      lastSynced: '',
    })
    await store.files.put({
      id: sourceUri,
      name: 'source.json',
      remoteId: sourceRemoteUri,
      lastRemoteChecksum: md5(sourceDoc),
      lastSynced: new Date().toISOString(),
      doc: sourceDoc,
      md5Checksum: md5(sourceDoc),
    })
    await store.files.put({
      id: oldConversionUri,
      name: 'source.runme',
      mimeType: RUNME_OPERATION_LOG_MIME_TYPE,
      remoteId: oldConversionRemoteUri,
      lastRemoteChecksum: oldSnapshot.checksum,
      lastSynced: new Date().toISOString(),
      lastSyncError: 'unrelated later failure',
      legacyConversionAttempt: {
        originalGoogleDriveId: 'original-drive-new-attempt',
        sourceChecksum: md5(sourceDoc),
        completedAt: '2026-09-03T00:00:00.000Z',
      },
      doc: '',
      md5Checksum: oldSnapshot.checksum,
      operationLogRef: oldSnapshot.ref,
    })
    vi.spyOn(store, 'syncFile').mockImplementation(async (uri: string) => {
      if (uri !== sourceUri) {
        await store.files.update(uri, { remoteId: newConversionRemoteUri })
      }
    })

    const result = await store.convertLegacyNotebookToRunme(
      sourceUri,
      parentUri
    )

    expect(result.uri).not.toBe(oldConversionUri)
    expect(result.remoteUri).toBe(newConversionRemoteUri)
    await expect(store.files.toArray()).resolves.toHaveLength(3)
  })
})

describe('LocalNotebooks rename', () => {
  it('preserves the runme extension when an extensionless name is used', async () => {
    const store = createTestStore({})
    await store.files.put({
      id: 'local://file/runme',
      name: 'original.runme',
      remoteId: 'local://file/runme',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    const result = await store.rename('local://file/runme', 'renamed')

    expect(result.name).toBe('renamed.runme')
    expect((await store.files.get('local://file/runme'))?.name).toBe(
      'renamed.runme'
    )
  })

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

  it('uses a resolved Drive URI when the local mirror upstream metadata is stale', async () => {
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
      remoteId: '',
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: '',
    })

    const result = await store.rename(
      'local://file/drive',
      'renamed.json',
      remoteUri
    )

    expect(driveStore.rename).toHaveBeenCalledWith(remoteUri, 'renamed.json')
    expect(result).toMatchObject({
      uri: 'local://file/drive',
      name: 'renamed.json',
      remoteUri,
    })
    expect((await store.files.get('local://file/drive'))?.remoteId).toBe(
      remoteUri
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

  it('deletes a trashed .runme notebook from OPFS storage', async () => {
    const remoteUri = 'https://drive.google.com/file/d/runme123/view'
    const operationLogStorage = new MemoryOperationLogStorage()
    const stored = await operationLogStorage.initialize(
      'local://file/shared',
      serializeOperationLog(
        {
          record_type: 'runme.notebook',
          format_version: 1,
          notebook_id: 'notebook_shared',
          created_by: 'actor_seed',
          created_at: '2026-09-03T00:00:00Z',
        },
        []
      )
    )
    const store = createTestStore(
      { moveToTrash: vi.fn(async () => undefined) },
      { operationLogStorage }
    )
    await store.files.put({
      id: 'local://file/shared',
      name: 'shared.runme',
      remoteId: remoteUri,
      lastRemoteChecksum: '',
      lastSynced: '',
      doc: '',
      md5Checksum: stored.checksum,
      operationLogRef: stored.ref,
    })

    await store.moveToTrash('local://file/shared')

    await expect(operationLogStorage.read(stored.ref)).rejects.toThrow(
      'Operation log not found'
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
      'revision-1',
      'notebook.json'
    )
  })

  it('routes cached IPYNB revision diffs through format-aware loading', async () => {
    const remoteUri = 'https://drive.google.com/file/d/file123/view'
    const revisionNotebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          kind: parser_pb.CellKind.CODE,
          value: 'echo historical runme json',
        }),
      ],
    })
    const driveStore = {
      loadRevision: vi.fn(async () => revisionNotebook),
      loadRevisionContent: vi.fn(),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/drive',
      name: 'notebook.ipynb',
      remoteId: remoteUri,
      lastRemoteChecksum: 'base-checksum',
      lastSynced: '2026-05-01T00:00:00.000Z',
      doc: notebookJson("print('local')"),
      md5Checksum: 'local-checksum',
    })

    await expect(
      store.getDriveRevisionDoc('local://file/drive', 'revision-1')
    ).resolves.toContain('echo historical runme json')
    expect(driveStore.loadRevision).toHaveBeenCalledWith(
      remoteUri,
      'revision-1',
      'notebook.ipynb'
    )
    expect(driveStore.loadRevisionContent).not.toHaveBeenCalled()
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

  it('saves the local conflict winner as nbformat for an IPYNB file', async () => {
    const remoteUri = 'https://drive.google.com/file/d/ipynb123/view'
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'local-cell',
          kind: parser_pb.CellKind.CODE,
          languageId: 'python',
          value: "print('local wins')",
        }),
      ],
    })
    const localDoc = encodeRunmeNotebook(notebook)
    let savedContent = ''
    const driveStore = {
      getVersionMetadata: vi
        .fn()
        .mockResolvedValueOnce({ md5Checksum: 'upstream-checksum' })
        .mockResolvedValueOnce({ md5Checksum: 'saved-checksum' }),
      saveContent: vi.fn(
        async (uri: string, content: string, mimeType: string) => {
          expect(uri).toBe(remoteUri)
          expect(mimeType).toBe(IPYNB_MIME_TYPE)
          savedContent = content
        }
      ),
    }
    const store = createTestStore(driveStore)
    await store.files.put({
      id: 'local://file/ipynb-conflict',
      name: 'notebook.ipynb',
      mimeType: IPYNB_MIME_TYPE,
      remoteId: remoteUri,
      lastRemoteChecksum: 'base-checksum',
      lastSynced: '',
      doc: localDoc,
      md5Checksum: 'local-checksum',
      conflict: {
        detectedAt: '2026-09-01T00:00:00.000Z',
        upstreamChecksum: 'upstream-checksum',
        upstreamDoc: encodeRunmeNotebook(
          create(parser_pb.NotebookSchema, { cells: [] })
        ),
        localChecksumAtDetection: 'local-checksum',
      },
    })

    await store.resolveConflictWithLocal('local://file/ipynb-conflict')

    expect(driveStore.saveContent).toHaveBeenCalledWith(
      remoteUri,
      expect.any(String),
      IPYNB_MIME_TYPE
    )
    const saved = JSON.parse(savedContent)
    expect(saved).toMatchObject({ nbformat: 4, nbformat_minor: 5 })
    expect(saved.cells[0]).toMatchObject({
      cell_type: 'code',
      id: 'local-cell',
      source: "print('local wins')",
    })
    expect(saved.cells[0]).not.toHaveProperty('kind')
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
