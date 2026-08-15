import { describe, expect, it } from 'vitest'

import { LEGACY_CELL_REF_IDS_METADATA_KEY } from './cellIdentity'
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
      version: 2,
    })
    expect(JSON.parse(anchor).runme).not.toHaveProperty('cellIdKind')
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
      version: 1,
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
      [{ refId: 'cell-2' }]
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

  it('resolves legacy kind-prefixed anchors to canonical cell ids', () => {
    const comments = [
      {
        id: 'legacy-comment',
        anchor: JSON.stringify({
          runme: {
            version: 1,
            type: 'cell',
            cellId: 'markup_intro',
            cellIdKind: 'runme-ref-id',
          },
        }),
        content: 'legacy',
      },
    ]

    expect(
      groupCommentsByCell(comments, [{ refId: 'intro' }]).get('intro')
    ).toHaveLength(1)
    expect(
      toCellCommentThreads(comments, [{ refId: 'intro' }])[0]
    ).toMatchObject({
      cellId: 'intro',
      orphaned: false,
      ambiguous: false,
    })
  })

  it('prefers exact canonical ids over legacy alias interpretations', () => {
    const comments = [
      {
        id: 'exact-comment',
        anchor: createCellCommentAnchor('markup_intro'),
        content: 'exact',
      },
    ]
    const cells = [{ refId: 'markup_intro' }, { refId: 'intro' }]

    expect(toCellCommentThreads(comments, cells)[0]).toMatchObject({
      cellId: 'markup_intro',
      orphaned: false,
      ambiguous: false,
    })
  })

  it('surfaces ambiguous legacy aliases instead of grouping them', () => {
    const comments = [
      {
        id: 'ambiguous-comment',
        anchor: createCellCommentAnchor('legacy id'),
        content: 'ambiguous',
      },
    ]
    const metadata = {
      [LEGACY_CELL_REF_IDS_METADATA_KEY]: JSON.stringify(['legacy id']),
    }
    const cells = [
      { refId: 'first', metadata },
      { refId: 'second', metadata },
    ]

    expect(groupCommentsByCell(comments, cells).size).toBe(0)
    expect(toCellCommentThreads(comments, cells)[0]).toMatchObject({
      cellId: 'legacy id',
      orphaned: false,
      ambiguous: true,
    })
  })
})
