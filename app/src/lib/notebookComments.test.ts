import { describe, expect, it } from 'vitest'

import { buildRenderedMarkdownProjection } from './markdown/renderedMarkdownProjection'
import {
  createCellCommentAnchor,
  createCellTextCommentAnchor,
  groupCommentsByCell,
  parseCellCommentAnchor,
  parseCommentAnchor,
  resolveRenderedTextAnchor,
  toCellCommentThreads,
} from './notebookComments'
import { createReviewAnchor } from './operationLog/reviews'

describe('notebook comment anchors', () => {
  it('projects diff comments into editor threads without losing source context or raw anchors', () => {
    const target = {
      cellId: 'cell-1',
      side: 'base' as const,
      quote: 'old text',
      sourceRange: { start: 0, end: 8, unit: 'utf-16' as const },
    }
    const raw = createReviewAnchor(
      'comparison',
      target.cellId,
      target.quote,
      target
    )
    const [thread] = toCellCommentThreads(
      [{ id: 'same-thread', anchor: raw, content: 'Change this' }],
      [{ refId: 'cell-1', value: 'new text' }]
    )
    expect(thread).toMatchObject({
      cellId: 'cell-1',
      anchor: { type: 'cell', diffTarget: target },
      location: { status: 'outdated' },
    })
    expect(thread.comment.anchor).toBe(raw)
    expect(
      groupCommentsByCell([thread.comment], [{ refId: 'cell-1' }]).get(
        'cell-1'
      )?.[0].id
    ).toBe('same-thread')
    expect(toCellCommentThreads([thread.comment], [])[0]).toMatchObject({
      orphaned: true,
      location: { status: 'cell-deleted' },
    })
  })
  it('does not project malformed comparison identities or mismatched target cells', () => {
    expect(
      parseCommentAnchor(
        JSON.stringify({ runme: { version: 1, type: 'review', cellId: 'c' } })
      )
    ).toBeNull()
    const anchor = JSON.parse(createReviewAnchor('r', 'c', 'quote'))
    anchor.runme.diffTarget = { cellId: 'other', quote: 'quote', side: 'head' }
    expect(parseCommentAnchor(JSON.stringify(anchor))).toBeNull()
  })
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
    const grouped = groupCommentsByCell(
      [
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
      ],
      [{ refId: 'cell-1' }]
    )

    expect(grouped.get('cell-1')?.map((comment) => comment.id)).toEqual([
      'comment-1',
    ])
  })

  it('treats legacy anchor cell ids as opaque and orphans missing ids', () => {
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

    expect(groupCommentsByCell(comments, [{ refId: 'intro' }]).size).toBe(0)
    expect(
      toCellCommentThreads(comments, [{ refId: 'intro' }])[0]
    ).toMatchObject({
      cellId: 'markup_intro',
      orphaned: true,
    })
  })

  it('resolves an exact cell id even when it has a historical prefix', () => {
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
    })
  })

  it('does not reinterpret missing v2 canonical ids as legacy aliases', () => {
    const comments = [
      {
        id: 'missing-v2-comment',
        anchor: createCellCommentAnchor('markup_intro'),
        content: 'missing canonical target',
      },
    ]
    const cells = [{ refId: 'intro' }]

    expect(groupCommentsByCell(comments, cells).size).toBe(0)
    expect(toCellCommentThreads(comments, cells)[0]).toMatchObject({
      cellId: 'markup_intro',
      orphaned: true,
    })
  })

  it('marks cell comments as orphaned when the notebook has no cells', () => {
    const [thread] = toCellCommentThreads(
      [
        {
          id: 'comment-with-no-target',
          anchor: createCellCommentAnchor('cell-1'),
          content: 'missing target',
        },
      ],
      []
    )

    expect(thread).toMatchObject({ cellId: 'cell-1', orphaned: true })
  })

  it('round-trips rendered Markdown selectors with revision state', async () => {
    const source = 'Read **the [migration guide](https://example.com)** today.'
    const projection = buildRenderedMarkdownProjection(source)
    const serialized = await createCellTextCommentAnchor(
      {
        type: 'cell-text',
        cellId: 'cell-1',
        surface: 'rendered-markdown',
        source,
        projection,
        selectors: [
          { type: 'TextPositionSelector', start: 5, end: 24 },
          {
            type: 'TextQuoteSelector',
            exact: 'the migration guide',
            prefix: 'Read ',
            suffix: ' today.',
          },
        ],
        sourceHints: [
          { start: 7, end: 11 },
          { start: 12, end: 27 },
        ],
      },
      'revision-7'
    )

    expect(parseCommentAnchor(serialized)).toMatchObject({
      type: 'cell-text',
      cellId: 'cell-1',
      surface: 'rendered-markdown',
      state: {
        driveRevisionId: 'revision-7',
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        projection: {
          name: 'runme-markdown-text',
          version: 1,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    })
  })

  it('resolves exact, moved, ambiguous, and outdated rendered targets', () => {
    const anchor = parseCommentAnchor(
      JSON.stringify({
        runme: {
          version: 2,
          type: 'cell-text',
          cellId: 'cell-1',
          surface: 'rendered-markdown',
          state: {
            driveRevisionId: 'revision-7',
            sourceSha256: 'source-hash',
            projection: {
              name: 'runme-markdown-text',
              version: 1,
              sha256: 'projection-hash',
            },
          },
          selectors: [
            { type: 'TextPositionSelector', start: 5, end: 24 },
            {
              type: 'TextQuoteSelector',
              exact: 'the migration guide',
              prefix: 'Read ',
              suffix: ' today.',
            },
          ],
        },
      })
    )
    expect(anchor?.type).toBe('cell-text')
    if (anchor?.type !== 'cell-text') {
      throw new Error('Expected a rendered text anchor')
    }

    expect(
      resolveRenderedTextAnchor(
        anchor,
        'Read **the [migration guide](https://example.com)** today.'
      )
    ).toEqual({ status: 'exact', start: 5, end: 24 })
    expect(
      resolveRenderedTextAnchor(
        anchor,
        'Before. Read **the [migration guide](https://example.com)** today.'
      )
    ).toEqual({ status: 'moved', start: 13, end: 32 })
    expect(
      resolveRenderedTextAnchor(
        anchor,
        'the migration guide and the migration guide'
      )
    ).toEqual({
      status: 'ambiguous',
      candidates: [
        { start: 0, end: 19 },
        { start: 24, end: 43 },
      ],
    })
    expect(resolveRenderedTextAnchor(anchor, 'The guide was removed.')).toEqual(
      {
        status: 'outdated',
      }
    )
  })
})
