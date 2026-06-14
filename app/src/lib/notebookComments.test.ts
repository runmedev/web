import { describe, expect, it } from 'vitest'

import {
  createCellCommentAnchor,
  groupCommentsByCell,
  parseCellCommentAnchor,
  toCellCommentThreads,
} from './notebookComments'

describe('notebook comment anchors', () => {
  it('round-trips cell anchors', () => {
    const anchor = createCellCommentAnchor('cell-123')

    expect(parseCellCommentAnchor(anchor)).toEqual({
      type: 'cell',
      cellId: 'cell-123',
      cellIdKind: 'runme-ref-id',
    })
  })

  it('parses legacy cell anchors written by earlier local builds', () => {
    expect(
      parseCellCommentAnchor(
        JSON.stringify({
          runme: { version: 1, kind: 'cell', cellId: 'cell-legacy' },
        })
      )
    ).toEqual({
      type: 'cell',
      cellId: 'cell-legacy',
      cellIdKind: 'runme-ref-id',
    })
  })

  it('rejects invalid or non-runme anchors', () => {
    expect(parseCellCommentAnchor(null)).toBeNull()
    expect(parseCellCommentAnchor('not-json')).toBeNull()
    expect(parseCellCommentAnchor(JSON.stringify({}))).toBeNull()
    expect(
      parseCellCommentAnchor(
        JSON.stringify({ runme: { version: 2, kind: 'cell', cellId: 'c1' } })
      )
    ).toBeNull()
  })

  it('marks anchored comments as orphaned when the cell is missing', () => {
    const [thread] = toCellCommentThreads(
      [
        {
          id: 'comment-1',
          anchor: createCellCommentAnchor('cell-1'),
          content: 'open',
        },
      ],
      new Set(['cell-2'])
    )

    expect(thread).toMatchObject({
      cellId: 'cell-1',
      orphaned: true,
    })
  })

  it('groups only unresolved cell comments', () => {
    const grouped = groupCommentsByCell([
      {
        id: 'comment-1',
        anchor: createCellCommentAnchor('cell-1'),
        content: 'open',
      },
      {
        id: 'comment-2',
        anchor: createCellCommentAnchor('cell-1'),
        resolved: true,
        content: 'resolved',
      },
      {
        id: 'comment-3',
        content: 'unanchored',
      },
    ])

    expect(grouped.get('cell-1')?.map((comment) => comment.id)).toEqual([
      'comment-1',
    ])
  })
})
