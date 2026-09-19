import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import { parser_pb } from '../runme/client'
import { computeNotebookDiff } from './notebookDiff/diff'
import type { previewComparison } from './operationLog/comparisons'
import { prepareSuggestionInput } from './suggestionGraderInput'
import { replayContent } from './trainingExamples/payloads'

function preview(
  before: Array<[string, string]>,
  after: Array<[string, string]>
) {
  const nb = (entries: Array<[string, string]>) =>
    create(parser_pb.NotebookSchema, {
      cells: entries.map(([refId, value]) =>
        create(parser_pb.CellSchema, {
          refId,
          value,
          kind: parser_pb.CellKind.MARKUP,
          languageId: 'markdown',
          metadata: { secret: 'excluded' },
        })
      ),
    })
  const a = nb(before),
    b = nb(after)
  return {
    before: a,
    after: b,
    diff: computeNotebookDiff(a, b, { matchCellIdsOnly: true }),
  } as ReturnType<typeof previewComparison>
}
describe('cell-scoped inference inputs', () => {
  it('keeps baseline context but excludes unrelated head edits', () => {
    const input = prepareSuggestionInput(
      preview(
        [
          ['a', 'old'],
          ['b', 'context'],
        ],
        [
          ['a', 'new'],
          ['b', 'unrelated secret'],
        ]
      ),
      'a'
    )
    expect(input.operations).toHaveLength(1)
    expect(
      replayContent(input.initial, input.operations).map((c) => c.cell.value)
    ).toEqual(['new', 'context'])
    expect(JSON.stringify(input)).not.toContain('unrelated secret')
    expect(JSON.stringify(input)).not.toContain('excluded')
  })
  it('inserts next to a surviving baseline predecessor, not a missing head-only cell', () => {
    const input = prepareSuggestionInput(
      preview(
        [['a', 'a']],
        [
          ['a', 'a'],
          ['x', 'x'],
          ['b', 'b'],
        ]
      ),
      'b'
    )
    expect(
      replayContent(input.initial, input.operations).map((c) => c.cell.value)
    ).toEqual(['a', 'b'])
  })
  it('represents deletions and moves on the intended cell only', () => {
    const del = prepareSuggestionInput(
      preview(
        [
          ['a', 'a'],
          ['b', 'b'],
        ],
        [['b', 'b']]
      ),
      'a'
    )
    expect(del.operations.map((o) => o.kind)).toEqual(['cell.delete'])
    const moved = prepareSuggestionInput(
      preview(
        [
          ['a', 'a'],
          ['b', 'b'],
        ],
        [
          ['b', 'b'],
          ['a', 'a'],
        ]
      ),
      'a'
    )
    expect(moved.operations.map((o) => o.payload.cell_id)).toEqual(['a'])
    expect(
      replayContent(moved.initial, moved.operations).map((c) => c.cell.value)
    ).toEqual(['b', 'a'])
  })
  it('does not grade metadata-only edits or cells outside the comparison', () => {
    expect(
      prepareSuggestionInput(preview([['a', 'a']], [['a', 'a']]), 'a')
        .operations
    ).toEqual([])
    expect(() => prepareSuggestionInput(preview([], []), 'a')).toThrow(
      'outside'
    )
  })
})
