import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import { parser_pb } from '../../runme/client'
import {
  computeReviewDiff,
  normalizeReviewCellIds,
  reviewIdentityKey,
  reviewOutlineSections,
  reviewSectionCellIds,
} from './reviewScope'

const notebook = (entries: [string, string][]) =>
  create(parser_pb.NotebookSchema, {
    cells: entries.map(([refId, value]) =>
      create(parser_pb.CellSchema, {
        refId,
        value,
        kind: parser_pb.CellKind.MARKUP,
        languageId: 'markdown',
      })
    ),
  })

describe('review scope', () => {
  it('accepts noncontiguous IDs in either endpoint, normalizes sets, and rejects invalid scopes', () => {
    const before = notebook([
      ['old', 'Same'],
      ['shared', 'Before'],
      ['unrelated', 'Before'],
    ])
    const after = notebook([
      ['new', 'Same'],
      ['shared', 'After'],
      ['unrelated', 'After'],
    ])
    expect(
      normalizeReviewCellIds(['shared', 'old', 'old', 'new'], before, after)
    ).toEqual(['new', 'old', 'shared'])
    expect(normalizeReviewCellIds(undefined, before, after)).toBeUndefined()
    for (const scope of [[], null, 'old', [123], ['missing'], ['']])
      expect(() => normalizeReviewCellIds(scope, before, after)).toThrow()
    const diff = computeReviewDiff(before, after, ['old', 'new'])
    expect(diff.cells.map((r) => r.kind).sort()).toEqual([
      'deleted',
      'inserted',
    ])
    expect(diff.summary).toMatchObject({
      insertedCells: 1,
      deletedCells: 1,
      modifiedCells: 0,
    })
    expect(computeReviewDiff(before, after, ['shared']).cells).toHaveLength(1)
    expect(reviewIdentityKey('a', 'b', ['old', 'new', 'old'])).toBe(
      reviewIdentityKey('a', 'b', ['new', 'old'])
    )
    expect(reviewIdentityKey('a', 'b', ['old'])).not.toBe(
      reviewIdentityKey('a', 'b', ['new'])
    )
    expect(reviewIdentityKey('a', 'b')).toBe(JSON.stringify(['a', 'b']))
  })

  it('selects a section with descendants, multiple sections, and whole-cell boundaries', () => {
    const doc = notebook([
      ['intro', '# Guide'],
      ['a', '## Setup'],
      ['body', 'Install'],
      ['sub', '### Linux'],
      ['code', 'Commands'],
      ['b', '## Deploy'],
      ['tail', 'Run'],
    ])
    const sections = reviewOutlineSections(doc)
    expect(sections.map((s) => [s.text, s.startIndex, s.endIndex])).toEqual([
      ['Guide', 0, 6],
      ['Setup', 1, 4],
      ['Linux', 3, 4],
      ['Deploy', 5, 6],
    ])
    expect(reviewSectionCellIds(doc, 'a:1', 'a:1')).toEqual([
      'a',
      'body',
      'sub',
      'code',
    ])
    expect(reviewSectionCellIds(doc, 'a:1', 'b:1')).toEqual([
      'a',
      'body',
      'sub',
      'code',
      'b',
      'tail',
    ])
    expect(() => reviewSectionCellIds(doc, 'b:1', 'a:1')).toThrow()
    const shared = notebook([
      ['both', '## A\ntext\n## B'],
      ['body', 'Body'],
    ])
    expect(reviewSectionCellIds(shared, 'both:1', 'both:1')).toEqual(['both'])
    expect(reviewSectionCellIds(shared, 'both:3', 'both:3')).toEqual([
      'both',
      'body',
    ])
  })
})
