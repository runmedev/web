import { describe, expect, it } from 'vitest'

import { acceptedCell, cellChangeKey } from './cellReview'
import { withCellReviewKeys } from './cellReviewIdentity'
import { createRunmeOperation } from './mutations'
import { computeReviewDiff } from './reviewScope'
import { materializeRevision } from './revisions'
import type { JsonValue, RunmeOperation } from './types'

describe('cell transition identity', () => {
  it('distinguishes a new deletion after restore from an already accepted deletion', () => {
    const ops: RunmeOperation[] = []
    const append = (kind: string, payload: JsonValue) => {
      ops.push(
        createRunmeOperation({
          actorId: 'a',
          actorSequence: ops.length + 1,
          dependencies: ops.slice(-1).map((op) => op.op_id),
          knownOperations: ops,
          kind,
          payload,
        })
      )
      return ops.map((op) => op.op_id)
    }
    const base = append('cell.create', {
      cell_id: 'one',
      position: [[100, 'a', 1]],
      cell: {
        kind: 'markup',
        value: 'Original',
        language_id: 'markdown',
        metadata: {},
      },
    })
    const deleted = append('cell.delete', { cell_id: 'one' })
    const unrelated = append('notebook.update', {
      metadata: { title: 'Later' },
      frontmatter: {},
    })
    const row = (head: string[]) =>
      withCellReviewKeys(
        computeReviewDiff(
          materializeRevision(ops, base),
          materializeRevision(ops, head)
        ),
        ops,
        base,
        head
      ).cells[0]
    expect(cellChangeKey(row(unrelated))).toBe(cellChangeKey(row(deleted)))
    expect(acceptedCell(row(deleted))).toBeUndefined()
    append('cell.restore', { cell_id: 'one' })
    const deletedAgain = append('cell.delete', { cell_id: 'one' })
    expect(cellChangeKey(row(deletedAgain))).not.toBe(
      cellChangeKey(row(deleted))
    )
  })
})
