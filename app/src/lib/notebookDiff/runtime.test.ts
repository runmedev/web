import { create, toJsonString } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { parser_pb } from '../../runme/client'
import type { DriveNotebookStore } from '../../storage/drive'
import type LocalNotebooks from '../../storage/local'
import { NotebookStoreItemType } from '../../storage/notebook'
import type { NotebooksApi } from '../runtime/runmeConsole'
import { createNotebookDiffRuntimeApi } from './runtime'

function notebook(value: string) {
  return create(parser_pb.NotebookSchema, {
    cells: [
      create(parser_pb.CellSchema, {
        refId: 'cell-1',
        kind: parser_pb.CellKind.CODE,
        languageId: 'python',
        value,
      }),
    ],
    metadata: {},
  })
}

function cell(refId: string, value: string) {
  return create(parser_pb.CellSchema, {
    refId,
    kind: parser_pb.CellKind.CODE,
    languageId: 'python',
    value,
  })
}

function notebookWithCells(cells: parser_pb.Cell[]) {
  return create(parser_pb.NotebookSchema, {
    cells,
    metadata: {},
  })
}

function serialize(notebookValue: parser_pb.Notebook): string {
  return toJsonString(parser_pb.NotebookSchema, notebookValue, {
    emitDefaultValues: true,
  } as unknown as Parameters<typeof toJsonString>[2])
}

describe('createNotebookDiffRuntimeApi', () => {
  it('lists plain Drive revisions for the current local notebook', async () => {
    const notebooksApi = {
      get: vi.fn().mockResolvedValue({
        summary: {
          uri: 'local://file/one',
          name: 'Notebook',
          isOpen: true,
          source: 'local',
        },
        handle: {
          uri: 'local://file/one',
          revision: 'local-revision',
        },
        notebook: notebook("print('local')"),
      }),
    } as unknown as NotebooksApi
    const localNotebooks = {
      getMetadata: vi.fn().mockResolvedValue({
        uri: 'local://file/one',
        name: 'Notebook',
        type: NotebookStoreItemType.File,
        children: [],
        remoteUri: 'https://drive.google.com/file/d/drive-file/view',
        parents: [],
      }),
    } as unknown as LocalNotebooks
    const driveStore = {
      listRevisions: vi.fn().mockResolvedValue([
        {
          id: 'revision-1',
          modifiedTime: '2026-05-25T00:00:00.000Z',
          size: '123',
          keepForever: true,
          lastModifyingUser: {
            displayName: 'User One',
            emailAddress: 'user@example.com',
          },
          ignoredField: 'not returned',
        },
        {
          modifiedTime: 'missing id',
        },
      ]),
    } as unknown as DriveNotebookStore

    const api = createNotebookDiffRuntimeApi({
      notebooksApi,
      resolveLocalNotebooks: () => localNotebooks,
      resolveDriveNotebookStore: () => driveStore,
    })

    const revisions = await api.listDriveRevisions()

    expect(revisions).toEqual([
      {
        id: 'revision-1',
        mimeType: undefined,
        modifiedTime: '2026-05-25T00:00:00.000Z',
        md5Checksum: undefined,
        size: '123',
        keepForever: true,
        lastModifyingUser: {
          displayName: 'User One',
          emailAddress: 'user@example.com',
        },
      },
    ])
  })

  it('accepts the internal current notebook object as a revision target', async () => {
    const notebooksApi = {
      get: vi.fn().mockResolvedValue({
        summary: {
          uri: 'local://file/one',
          name: 'Notebook',
          isOpen: true,
          source: 'local',
        },
        handle: {
          uri: 'local://file/one',
          revision: 'local-revision',
        },
        notebook: notebook("print('local')"),
      }),
    } as unknown as NotebooksApi
    const localNotebooks = {
      getMetadata: vi.fn().mockResolvedValue({
        uri: 'local://file/one',
        name: 'Notebook',
        type: NotebookStoreItemType.File,
        children: [],
        remoteUri: 'https://drive.google.com/file/d/drive-file/view',
        parents: [],
      }),
    } as unknown as LocalNotebooks
    const driveStore = {
      listRevisions: vi.fn().mockResolvedValue([
        {
          id: 'revision-1',
        },
      ]),
    } as unknown as DriveNotebookStore

    const api = createNotebookDiffRuntimeApi({
      notebooksApi,
      resolveLocalNotebooks: () => localNotebooks,
      resolveDriveNotebookStore: () => driveStore,
    })

    await api.listDriveRevisions({
      getUri: () => 'local://file/one',
    })

    expect(notebooksApi.get).toHaveBeenCalledWith({
      uri: 'local://file/one',
    })
  })

  it('computes a diff against a Drive revision for the current local notebook', async () => {
    const notebooksApi = {
      get: vi.fn().mockResolvedValue({
        summary: {
          uri: 'local://file/one',
          name: 'Notebook',
          isOpen: true,
          source: 'local',
        },
        handle: {
          uri: 'local://file/one',
          revision: 'local-revision',
        },
        notebook: notebook("print('local')"),
      }),
    } as unknown as NotebooksApi
    const localNotebooks = {
      getMetadata: vi.fn().mockResolvedValue({
        uri: 'local://file/one',
        name: 'Notebook',
        type: NotebookStoreItemType.File,
        children: [],
        remoteUri: 'https://drive.google.com/file/d/drive-file/view',
        parents: [],
      }),
    } as unknown as LocalNotebooks
    const driveStore = {
      loadRevision: vi.fn().mockResolvedValue(notebook("print('base')")),
    } as unknown as DriveNotebookStore

    const api = createNotebookDiffRuntimeApi({
      notebooksApi,
      resolveLocalNotebooks: () => localNotebooks,
      resolveDriveNotebookStore: () => driveStore,
    })

    const doc = await api.diffDriveRevision({
      revisionId: 'revision-1',
    })

    expect(driveStore.loadRevision).toHaveBeenCalledWith(
      'https://drive.google.com/file/d/drive-file/view',
      'revision-1'
    )
    expect(doc.base.revisionId).toBe('revision-1')
    expect(doc.compare.revisionId).toBe('local-revision')
    expect(doc.diff.summary.sourceChanges).toBe(1)
  })

  it('lists sync conflict cells for the current local notebook', async () => {
    const upstreamNotebook = notebookWithCells([cell('a', 'a'), cell('b', 'b')])
    const localNotebook = notebookWithCells([cell('a', 'local a')])
    const notebooksApi = {
      get: vi.fn().mockResolvedValue({
        handle: {
          uri: 'local://file/conflict',
          revision: 'local-revision',
        },
        notebook: localNotebook,
      }),
    } as unknown as NotebooksApi
    const localNotebooks = {
      files: {
        get: vi.fn().mockResolvedValue({
          id: 'local://file/conflict',
          name: 'conflict.json',
          doc: serialize(localNotebook),
          conflict: {
            detectedAt: '2026-06-01T00:00:00.000Z',
            upstreamChecksum: 'upstream',
            localChecksumAtDetection: 'local',
          },
        }),
      },
      getConflictUpstreamDoc: vi.fn(async () => serialize(upstreamNotebook)),
    } as unknown as LocalNotebooks

    const api = createNotebookDiffRuntimeApi({
      notebooksApi,
      resolveLocalNotebooks: () => localNotebooks,
      resolveDriveNotebookStore: () => null,
    })

    const rows = await api.listConflictCells()

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'deleted',
          baseRefId: 'b',
          baseValue: 'b',
        }),
      ])
    )
  })

  it('restores all deleted upstream conflict cells through the runtime API', async () => {
    const upstreamNotebook = notebookWithCells([
      cell('a', 'a'),
      cell('b', 'b'),
      cell('c', 'c'),
      cell('d', 'd'),
    ])
    const localNotebook = notebookWithCells([
      cell('a', 'local a'),
      cell('d', 'local d'),
    ])
    let record = {
      id: 'local://file/conflict',
      name: 'conflict.json',
      doc: serialize(localNotebook),
      conflict: {
        detectedAt: '2026-06-01T00:00:00.000Z',
        upstreamChecksum: 'upstream',
        localChecksumAtDetection: 'local',
      },
    }
    const notebooksApi = {
      get: vi.fn().mockResolvedValue({
        handle: {
          uri: 'local://file/conflict',
          revision: 'local-revision',
        },
        notebook: localNotebook,
      }),
    } as unknown as NotebooksApi
    const localNotebooks = {
      files: {
        get: vi.fn(async () => record),
      },
      getConflictUpstreamDoc: vi.fn(async () => serialize(upstreamNotebook)),
      save: vi.fn(async (_localUri: string, saved: parser_pb.Notebook) => {
        record = {
          ...record,
          doc: serialize(saved),
        }
      }),
    } as unknown as LocalNotebooks
    const liveNotebook = {
      getUri: () => 'local://file/conflict',
      getNotebook: () => localNotebook,
      flushPendingPersist: vi.fn(async () => undefined),
      loadNotebook: vi.fn(),
    }
    const currentNotebook = {
      getUri: () => 'local://file/current',
      getNotebook: () => notebookWithCells([]),
      flushPendingPersist: vi.fn(async () => undefined),
      loadNotebook: vi.fn(),
    }
    const resolveNotebook = vi.fn((target?: { uri?: string }) =>
      target?.uri === 'local://file/conflict' ? liveNotebook : currentNotebook
    )

    const api = createNotebookDiffRuntimeApi({
      notebooksApi,
      resolveLocalNotebooks: () => localNotebooks,
      resolveDriveNotebookStore: () => null,
      resolveNotebook: resolveNotebook as any,
    })

    const result = await api.restoreAllDeletedCells({
      localUri: 'local://file/conflict',
    })

    expect(liveNotebook.flushPendingPersist).toHaveBeenCalledTimes(1)
    expect(liveNotebook.loadNotebook).toHaveBeenCalledWith(
      result.localNotebook,
      { persist: false }
    )
    expect(currentNotebook.flushPendingPersist).not.toHaveBeenCalled()
    expect(currentNotebook.loadNotebook).not.toHaveBeenCalled()
    expect(resolveNotebook).toHaveBeenCalledWith({
      uri: 'local://file/conflict',
    })
    expect(localNotebooks.save).toHaveBeenCalledTimes(2)
    expect(
      result.localNotebook.cells.map((savedCell) => savedCell.refId)
    ).toEqual(['a', 'b', 'c', 'd'])
    expect(result.document.diff.summary.deletedCells).toBe(0)
  })
})
