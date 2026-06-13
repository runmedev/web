import { describe, expect, it } from 'vitest'

import {
  createCellCommentAnchor,
  groupCommentsByCell,
  parseCellCommentAnchor,
} from './notebookComments'

describe('notebook comment anchors', () => {
  it('round-trips cell anchors', () => {
    const anchor = createCellCommentAnchor('cell-123')

    expect(parseCellCommentAnchor(anchor)).toEqual({
      kind: 'cell',
      cellId: 'cell-123',
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
