import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import { parser_pb } from '../runme/client'
import {
  LEGACY_CELL_REF_IDS_METADATA_KEY,
  assertCanonicalNotebookCellIds,
  migrateNotebookCellIds,
} from './cellIdentity'

describe('cell identity', () => {
  it('migrates invalid and duplicate legacy ids deterministically', () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, { refId: 'invalid id' }),
        create(parser_pb.CellSchema, { refId: 'invalid id' }),
        create(parser_pb.CellSchema, { refId: '' }),
      ],
    })

    migrateNotebookCellIds(notebook)

    expect(notebook.cells.map((cell) => cell.refId)).toEqual([
      'invalid-id',
      'invalid-id-2',
      'cell-3',
    ])
    expect(notebook.cells[0]?.metadata[LEGACY_CELL_REF_IDS_METADATA_KEY]).toBe(
      '["invalid id"]'
    )
    expect(notebook.cells[1]?.metadata[LEGACY_CELL_REF_IDS_METADATA_KEY]).toBe(
      '["invalid id"]'
    )
    expect(migrateNotebookCellIds(notebook).changed).toBe(false)
  })

  it('uses old IPYNB preservation mappings without persisting a prefix alias', () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [create(parser_pb.CellSchema, { refId: 'markup_intro' })],
    })

    migrateNotebookCellIds(notebook, { markup_intro: 'intro' })

    expect(notebook.cells[0]?.refId).toBe('intro')
    expect(
      notebook.cells[0]?.metadata[LEGACY_CELL_REF_IDS_METADATA_KEY]
    ).toBeUndefined()
  })

  it('promotes a legacy metadata id to the canonical refId', () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          metadata: { 'runme.dev/id': 'legacy-id' },
        }),
      ],
    })

    migrateNotebookCellIds(notebook)

    expect(notebook.cells[0]?.refId).toBe('legacy-id')
  })

  it('removes the obsolete internal IPYNB id copy', () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'canonical-id',
          metadata: { 'runme.dev/ipynbCellId': 'canonical-id' },
        }),
      ],
    })

    migrateNotebookCellIds(notebook)

    expect(notebook.cells[0]?.metadata['runme.dev/ipynbCellId']).toBeUndefined()
  })

  it('uses an obsolete internal IPYNB id copy to migrate a prefixed refId', () => {
    const notebook = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'code_source-id',
          metadata: { 'runme.dev/ipynbCellId': 'source-id' },
        }),
      ],
    })

    migrateNotebookCellIds(notebook)

    expect(notebook.cells[0]?.refId).toBe('source-id')
    expect(notebook.cells[0]?.metadata['runme.dev/ipynbCellId']).toBeUndefined()
  })

  it('rejects invalid or duplicate canonical ids before IPYNB encoding', () => {
    const invalid = create(parser_pb.NotebookSchema, {
      cells: [create(parser_pb.CellSchema, { refId: 'invalid id' })],
    })
    expect(() => assertCanonicalNotebookCellIds(invalid)).toThrow(
      'invalid canonical refId'
    )

    const duplicate = create(parser_pb.NotebookSchema, {
      cells: [
        create(parser_pb.CellSchema, { refId: 'same' }),
        create(parser_pb.CellSchema, { refId: 'same' }),
      ],
    })
    expect(() => assertCanonicalNotebookCellIds(duplicate)).toThrow(
      'Duplicate canonical cell refId: same'
    )
  })
})
