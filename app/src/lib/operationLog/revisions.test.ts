import { describe, expect, it } from 'vitest'

import { createRunmeOperation } from './mutations'
import { buildReviewRounds } from './reviews'
import {
  buildNotebookRevisions,
  materializeRevision,
  revisionFollows,
} from './revisions'
import type { JsonValue, RunmeOperation } from './types'

function journal() {
  const ops: RunmeOperation[] = []
  const append = (
    kind: string,
    payload: JsonValue,
    options: Partial<
      Omit<Parameters<typeof createRunmeOperation>[0], 'kind' | 'payload'>
    > = {}
  ) => {
    const op = createRunmeOperation({
      actorId: 'a',
      actorSequence: ops.length + 1,
      knownOperations: ops,
      dependencies: ops.slice(-1).map((op) => op.op_id),
      kind,
      payload,
      ...options,
    })
    ops.push(op)
    return op
  }
  const seed = () =>
    append('cell.create', {
      cell_id: 'one',
      position: [[100, 'a', 1]],
      cell: {
        kind: 'markup',
        value: 'First',
        language_id: 'markdown',
        metadata: {},
      },
    })
  return { ops, append, seed }
}
describe('notebook revision history', () => {
  it('labels historical versions without changing their dates or introducing a revision', () => {
    const j = journal()
    const first = j.seed()
    first.created_at = '2026-09-05T23:13:00Z'
    const old = buildNotebookRevisions(j.ops).at(-1)!
    j.append('cell.update', { cell_id: 'one', cell: { value: 'Second' } })
    j.append('revision.label', {
      revisionId: old.id,
      operationIds: old.operationIds,
      name: 'Version',
      description: 'Codex addressed comments',
    })
    const revisions = buildNotebookRevisions(j.ops)
    expect(revisions).toHaveLength(3)
    expect(revisions.find((r) => r.id === old.id)).toMatchObject({
      name: 'Version',
      description: 'Codex addressed comments',
      lastChangedAt: '2026-09-05T23:13:00Z',
    })
    expect(materializeRevision(j.ops, old.operationIds).cells[0].value).toBe(
      'First'
    )
    expect(revisionFollows(revisions[1], revisions[2])).toBe(true)
    expect(revisionFollows(revisions[2], revisions[1])).toBe(false)
    expect(revisionFollows(revisions[1], revisions[1])).toBe(false)
    expect(buildNotebookRevisions([...j.ops].reverse())).toEqual(revisions)
  })
  it('only exposes complete saves and keeps labels stable after a concurrent branch merges', () => {
    const j = journal()
    const member = j.append(
      'cell.create',
      {
        cell_id: 'one',
        position: [[100, 'a', 1]],
        cell: {
          kind: 'markup',
          value: 'Atomic',
          language_id: 'markdown',
          metadata: {},
        },
      },
      { transactionId: 'tx' }
    )
    expect(buildNotebookRevisions(j.ops)).toHaveLength(1)
    j.append('transaction.commit', {
      transaction_id: 'tx',
      members: [member.op_id],
    })
    const revision = buildNotebookRevisions(j.ops).at(-1)!
    j.append('revision.label', {
      revisionId: revision.id,
      operationIds: revision.operationIds,
      name: 'Atomic save',
      description: '',
    })
    const branch = createRunmeOperation({
      actorId: 'other',
      actorSequence: 1,
      knownOperations: [],
      dependencies: [],
      kind: 'notebook.update',
      payload: { metadata: { branch: 'true' } },
    })
    const merged = buildNotebookRevisions([...j.ops, branch])
    expect(merged.find((r) => r.id === revision.id)?.name).toBe('Atomic save')
    expect(
      materializeRevision([...j.ops, branch], revision.operationIds).metadata
        .branch
    ).toBeUndefined()
  })
  it('coalesces concurrent reviews for a pair while retaining causal submissions', () => {
    const j = journal()
    const seed = j.seed()
    const payload = {
      id: 'pair',
      title: 'Review',
      baseOperationIds: [],
      headOperationIds: [seed.op_id],
    }
    const first = j.append('review.create', payload)
    const second = j.append('review.create', payload, {
      actorId: 'b',
      actorSequence: 1,
      dependencies: [seed.op_id],
    })
    j.append(
      'review.submit',
      { reviewId: 'pair', outcome: 'approve' },
      { actorId: 'b', actorSequence: 2, dependencies: [second.op_id] }
    )
    const rounds = buildReviewRounds(j.ops)
    expect(rounds).toHaveLength(1)
    expect(rounds[0].outcome).toBe('approve')
    expect(buildReviewRounds([...j.ops].reverse())).toEqual(rounds)
    expect(first.op_id).not.toBe(second.op_id)
  })
})
