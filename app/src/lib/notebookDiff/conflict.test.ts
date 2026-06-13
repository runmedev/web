import { create, toJsonString } from '@bufbuild/protobuf'
import { describe, expect, it, vi } from 'vitest'

import { RunmeMetadataKey, parser_pb } from '../../runme/client'
import type LocalNotebooks from '../../storage/local'
import { restoreDeletedConflictCell } from './conflict'
import { computeNotebookDiff } from './diff'

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
