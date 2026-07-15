import { create, toJsonString } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { RunmeMetadataKey, parser_pb } from '../../runme/client'
import type LocalNotebooks from '../../storage/local'
import {
  openNotebookDriveRevisionDiff,
  openNotebookUpstreamDiff,
  removeInsertedConflictCell,
  restoreDeletedConflictCell,
} from './conflict'
import { computeNotebookDiff } from './diff'
import { getNotebookDiffDocument } from './registry'

const NOTEBOOK_JSON_WRITE_OPTIONS = {
  emitDefaultValues: true,
} as unknown as Parameters<typeof toJsonString>[2]

function cell(args: {
  refId: string
  value: string
  createdAt?: string
}): parser_pb.Cell {
  return create(parser_pb.CellSchema, {
    refId: args.refId,
    kind: parser_pb.CellKind.CODE,
    languageId: 'python',
    value: args.value,
    metadata: args.createdAt
      ? { [RunmeMetadataKey.CreatedAt]: args.createdAt }
      : {},
  })
}

function notebook(cells: parser_pb.Cell[]): parser_pb.Notebook {
  return create(parser_pb.NotebookSchema, {
    cells,
    metadata: {},
  })
}

function serialize(notebookValue: parser_pb.Notebook): string {
  return toJsonString(
    parser_pb.NotebookSchema,
    notebookValue,
    NOTEBOOK_JSON_WRITE_OPTIONS
  )
}

describe('restoreDeletedConflictCell', () => {
  it('inserts a deleted upstream cell after the nearest surviving previous cell', async () => {
    const upstreamNotebook = notebook([
      cell({ refId: 'a', value: 'a' }),
      cell({ refId: 'b', value: 'b' }),
      cell({ refId: 'c', value: 'c' }),
    ])
    const localNotebook = notebook([
      cell({ refId: 'a', value: 'local a' }),
      cell({ refId: 'c', value: 'local c' }),
    ])
    const diff = computeNotebookDiff(upstreamNotebook, localNotebook)
    const deletedRow = diff.cells.find((row) => row.baseCell?.refId === 'b')
    let record = {
      id: 'local://file/conflict',
      name: 'conflict.json',
      remoteId: 'https://drive.google.com/file/d/file123/view',
      lastRemoteChecksum: 'base',
      lastSynced: '',
      doc: serialize(localNotebook),
      md5Checksum: 'local',
      conflict: {
        detectedAt: '2026-06-01T00:00:00.000Z',
        upstreamChecksum: 'upstream',
        localChecksumAtDetection: 'local',
      },
    }
    const store = {
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

    await restoreDeletedConflictCell(
      store,
      'local://file/conflict',
      deletedRow!
    )

    expect(store.save).toHaveBeenCalledTimes(1)
    const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0][1] as
      | parser_pb.Notebook
      | undefined
    expect(saved?.cells.map((savedCell) => savedCell.refId)).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(saved?.cells[1]?.metadata?.[RunmeMetadataKey.CreatedAt]).toBeTruthy()
    expect(saved?.cells[1]?.metadata?.[RunmeMetadataKey.UpdatedAt]).toBeTruthy()
  })

  it('merges restored cells into the live notebook snapshot when provided', async () => {
    const upstreamNotebook = notebook([
      cell({ refId: 'a', value: 'a' }),
      cell({ refId: 'b', value: 'b' }),
      cell({ refId: 'c', value: 'c' }),
    ])
    const staleLocalNotebook = notebook([
      cell({ refId: 'a', value: 'stale a' }),
      cell({ refId: 'c', value: 'local c' }),
    ])
    const liveLocalNotebook = notebook([
      cell({ refId: 'a', value: 'unsaved a edit' }),
      cell({ refId: 'c', value: 'local c' }),
    ])
    const diff = computeNotebookDiff(upstreamNotebook, staleLocalNotebook)
    const deletedRow = diff.cells.find((row) => row.baseCell?.refId === 'b')
    let record = {
      id: 'local://file/conflict',
      name: 'conflict.json',
      remoteId: 'https://drive.google.com/file/d/file123/view',
      lastRemoteChecksum: 'base',
      lastSynced: '',
      doc: serialize(staleLocalNotebook),
      md5Checksum: 'local',
      conflict: {
        detectedAt: '2026-06-01T00:00:00.000Z',
        upstreamChecksum: 'upstream',
        localChecksumAtDetection: 'local',
      },
    }
    const store = {
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

    await restoreDeletedConflictCell(
      store,
      'local://file/conflict',
      deletedRow!,
      { localNotebook: liveLocalNotebook }
    )

    const saved = (store.save as ReturnType<typeof vi.fn>).mock.calls[0][1] as
      | parser_pb.Notebook
      | undefined
    expect(saved?.cells.map((savedCell) => savedCell.refId)).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(saved?.cells[0]?.value).toBe('unsaved a edit')
  })
})

describe('removeInsertedConflictCell', () => {
  it('removes a local-only cell while preserving other live notebook edits', async () => {
    const upstreamNotebook = notebook([
      cell({ refId: 'a', value: 'a' }),
      cell({ refId: 'c', value: 'c' }),
    ])
    const staleLocalNotebook = notebook([
      cell({ refId: 'a', value: 'stale a' }),
      cell({ refId: 'local-only', value: 'remove me' }),
      cell({ refId: 'c', value: 'c' }),
    ])
    const liveLocalNotebook = notebook([
      cell({ refId: 'a', value: 'unsaved a edit' }),
      cell({ refId: 'local-only', value: 'remove me' }),
      cell({ refId: 'c', value: 'c' }),
    ])
    const diff = computeNotebookDiff(upstreamNotebook, staleLocalNotebook)
    const insertedRow = diff.cells.find(
      (row) => row.compareCell?.refId === 'local-only'
    )
    let record = {
      id: 'local://file/conflict',
      name: 'conflict.json',
      remoteId: 'https://drive.google.com/file/d/file123/view',
      lastRemoteChecksum: 'base',
      lastSynced: '',
      doc: serialize(staleLocalNotebook),
      md5Checksum: 'local',
      conflict: {
        detectedAt: '2026-06-01T00:00:00.000Z',
        upstreamChecksum: 'upstream',
        localChecksumAtDetection: 'local',
      },
    }
    const store = {
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

    const result = await removeInsertedConflictCell(
      store,
      'local://file/conflict',
      insertedRow!,
      { localNotebook: liveLocalNotebook }
    )

    expect(store.save).toHaveBeenCalledTimes(1)
    expect(
      result.localNotebook.cells.map((savedCell) => savedCell.refId)
    ).toEqual(['a', 'c'])
    expect(result.localNotebook.cells[0]?.value).toBe('unsaved a edit')
    expect(result.document.diff.summary.insertedCells).toBe(0)
  })

  it('removes the indexed local-only cell when refIds are duplicated', async () => {
    const upstreamNotebook = notebook([
      cell({ refId: 'duplicate', value: 'upstream value' }),
    ])
    const localNotebook = notebook([
      cell({ refId: 'duplicate', value: 'keep me' }),
      cell({ refId: 'duplicate', value: 'remove me' }),
    ])
    const diff = computeNotebookDiff(upstreamNotebook, localNotebook)
    const insertedRow = diff.cells.find(
      (row) => row.kind === 'inserted' && row.compareCell?.value === 'remove me'
    )
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
    const store = {
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

    const result = await removeInsertedConflictCell(
      store,
      'local://file/conflict',
      insertedRow!
    )

    expect(result.localNotebook.cells).toHaveLength(1)
    expect(result.localNotebook.cells[0]?.value).toBe('keep me')
    expect(result.document.diff.summary.insertedCells).toBe(0)
  })
})

describe('Drive upstream diff documents', () => {
  it('opens a generic upstream diff for Drive-backed notebooks without a conflict', async () => {
    const localUri = 'local://file/drive'
    const record = {
      id: localUri,
      name: 'drive.json',
      remoteId: 'https://drive.google.com/file/d/file123/view',
      lastRemoteChecksum: 'base',
      lastSynced: '',
      lastUpstreamVersion: { revisionId: 'revision-5' },
      doc: serialize(notebook([cell({ refId: 'a', value: 'local' })])),
      md5Checksum: 'local',
    }
    const store = {
      files: {
        get: vi.fn(async () => record),
      },
      getDriveUpstreamDoc: vi.fn(async () => ({
        doc: serialize(notebook([cell({ refId: 'a', value: 'upstream' })])),
        version: { revisionId: 'revision-5' },
      })),
    } as unknown as LocalNotebooks

    await openNotebookUpstreamDiff(store, localUri)

    const document = getNotebookDiffDocument(
      `drive-upstream-diff-${encodeURIComponent(localUri)}`
    )
    expect(document?.base).toEqual({
      label: 'Upstream version',
      revisionId: 'revision-5',
    })
    expect(document?.resolution).toEqual({
      kind: 'drive-upstream-diff',
      localUri,
      upstreamRevisionId: 'revision-5',
    })
  })

  it('reuses the upstream document when selecting the current upstream revision', async () => {
    const localUri = 'local://file/drive'
    const record = {
      id: localUri,
      name: 'drive.json',
      remoteId: 'https://drive.google.com/file/d/file123/view',
      lastRemoteChecksum: 'base',
      lastSynced: '',
      lastUpstreamVersion: { revisionId: 'revision-5' },
      doc: serialize(notebook([cell({ refId: 'a', value: 'local' })])),
      md5Checksum: 'local',
    }
    const store = {
      files: {
        get: vi.fn(async () => record),
      },
      getDriveUpstreamDoc: vi.fn(async () => ({
        doc: serialize(notebook([cell({ refId: 'a', value: 'upstream' })])),
        version: { revisionId: 'revision-5' },
      })),
      getDriveRevisionDoc: vi.fn(),
    } as unknown as LocalNotebooks

    await openNotebookDriveRevisionDiff(store, localUri, 'revision-5', {
      resolutionKind: 'drive-upstream-diff',
      currentUpstreamRevisionId: 'revision-5',
    })

    expect(store.getDriveRevisionDoc).not.toHaveBeenCalled()
    expect(
      getNotebookDiffDocument(
        `drive-upstream-diff-${encodeURIComponent(localUri)}`
      )?.base.label
    ).toBe('Upstream version')
  })

  it('does not fetch the current upstream document before loading an older generic revision', async () => {
    const localUri = 'local://file/drive'
    const record = {
      id: localUri,
      name: 'drive.json',
      remoteId: 'https://drive.google.com/file/d/file123/view',
      lastRemoteChecksum: 'base',
      lastSynced: '',
      lastUpstreamVersion: { revisionId: 'revision-5' },
      doc: serialize(notebook([cell({ refId: 'a', value: 'local' })])),
      md5Checksum: 'local',
    }
    const store = {
      files: {
        get: vi.fn(async () => record),
      },
      getDriveUpstreamDoc: vi.fn(async () => {
        throw new Error('current upstream should not be fetched')
      }),
      getDriveRevisionDoc: vi.fn(async () =>
        serialize(notebook([cell({ refId: 'a', value: 'older' })]))
      ),
    } as unknown as LocalNotebooks

    await openNotebookDriveRevisionDiff(store, localUri, 'revision-1', {
      resolutionKind: 'drive-upstream-diff',
      currentUpstreamRevisionId: 'revision-5',
    })

    expect(store.getDriveUpstreamDoc).not.toHaveBeenCalled()
    expect(store.getDriveRevisionDoc).toHaveBeenCalledWith(
      localUri,
      'revision-1'
    )
    expect(
      getNotebookDiffDocument(
        `drive-upstream-diff-${encodeURIComponent(localUri)}`
      )?.base
    ).toEqual({
      label: 'Drive revision revision-1',
      revisionId: 'revision-1',
    })
  })

  it('loads a stale current-upstream revision as a historical revision after verifying Drive head', async () => {
    const localUri = 'local://file/drive'
    const record = {
      id: localUri,
      name: 'drive.json',
      remoteId: 'https://drive.google.com/file/d/file123/view',
      lastRemoteChecksum: 'base',
      lastSynced: '',
      lastUpstreamVersion: { revisionId: 'revision-5' },
      doc: serialize(notebook([cell({ refId: 'a', value: 'local' })])),
      md5Checksum: 'local',
    }
    const store = {
      files: {
        get: vi.fn(async () => record),
      },
      getDriveUpstreamDoc: vi.fn(async () => ({
        doc: serialize(
          notebook([cell({ refId: 'a', value: 'new upstream head' })])
        ),
        version: { revisionId: 'revision-6' },
      })),
      getDriveRevisionDoc: vi.fn(async () =>
        serialize(notebook([cell({ refId: 'a', value: 'older' })]))
      ),
    } as unknown as LocalNotebooks

    await openNotebookDriveRevisionDiff(store, localUri, 'revision-5', {
      resolutionKind: 'drive-upstream-diff',
      currentUpstreamRevisionId: 'revision-5',
    })

    expect(store.getDriveUpstreamDoc).toHaveBeenCalledWith(localUri)
    expect(store.getDriveRevisionDoc).toHaveBeenCalledWith(
      localUri,
      'revision-5'
    )
    expect(
      getNotebookDiffDocument(
        `drive-upstream-diff-${encodeURIComponent(localUri)}`
      )?.base
    ).toEqual({
      label: 'Drive revision revision-5',
      revisionId: 'revision-5',
    })
  })

  it('keeps conflict revision selections in the existing conflict diff document', async () => {
    const localUri = 'local://file/conflict'
    const record = {
      id: localUri,
      name: 'conflict.json',
      remoteId: 'https://drive.google.com/file/d/file123/view',
      lastRemoteChecksum: 'base',
      lastSynced: '',
      doc: serialize(notebook([cell({ refId: 'a', value: 'local' })])),
      md5Checksum: 'local',
      conflict: {
        detectedAt: '2026-06-01T00:00:00.000Z',
        upstreamChecksum: 'upstream',
        upstreamVersion: { revisionId: 'revision-5' },
        localChecksumAtDetection: 'local',
      },
    }
    const store = {
      files: {
        get: vi.fn(async () => record),
      },
      getConflictUpstreamDoc: vi.fn(async () =>
        serialize(notebook([cell({ refId: 'a', value: 'upstream' })]))
      ),
      getDriveRevisionDoc: vi.fn(async () =>
        serialize(notebook([cell({ refId: 'a', value: 'older' })]))
      ),
    } as unknown as LocalNotebooks

    await openNotebookDriveRevisionDiff(store, localUri, 'revision-1')

    const document = getNotebookDiffDocument(
      `conflict-${encodeURIComponent(localUri)}`
    )
    expect(store.getDriveRevisionDoc).toHaveBeenCalledWith(
      localUri,
      'revision-1'
    )
    expect(document?.base).toEqual({
      label: 'Drive revision revision-1',
      revisionId: 'revision-1',
    })
    expect(document?.resolution?.kind).toBe('notebook-sync-conflict')
  })
})
