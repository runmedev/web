import { describe, expect, it } from 'vitest'

import { createRunmeOperation, materializeOperationLog } from '.'
import {
  buildReviewRounds,
  captureReviewRevision,
  normalizeAttribution,
} from './reviews'
import type { JsonValue, RunmeOperation } from './types'

/** A real journal fixture: each appended operation observes the preceding one. */
function journal() {
  const operations: RunmeOperation[] = []
  const append = (
    kind: string,
    payload: JsonValue,
    options: Partial<
      Omit<Parameters<typeof createRunmeOperation>[0], 'payload'>
    > = {}
  ) => {
    const operation = createRunmeOperation({
      actorId: 'reviewer',
      actorSequence: operations.length + 1,
      knownOperations: operations,
      dependencies: operations.slice(-1).map((op) => op.op_id),
      kind,
      payload,
      ...options,
    })
    operations.push(operation)
    return operation
  }
  const cell = (value: string) => ({
    kind: 'markup',
    language_id: 'markdown',
    value,
    metadata: {},
  })
  const seed = () =>
    append('cell.create', {
      cell_id: 'one',
      position: [[100, 'reviewer', 1]],
      cell: cell('Original'),
    })
  const review = (
    id: string,
    baseOperationIds: string[] = [],
    previousReviewId?: string
  ) =>
    append('review.create', {
      id,
      title: id,
      baseOperationIds,
      headOperationIds: captureReviewRevision(operations),
      ...(previousReviewId ? { previousReviewId } : {}),
    })
  return { operations, append, cell, seed, review }
}

describe('fixed notebook review rounds', () => {
  it('keeps separate scopes over the same pair and coalesces reordered concurrent scope sets', () => {
    const j = journal()
    j.seed()
    j.append('cell.create', {
      cell_id: 'two',
      position: [[200, 'reviewer', 2]],
      cell: j.cell('Second'),
    })
    const headOperationIds = captureReviewRevision(j.operations)
    const input = { title: 'Scoped', baseOperationIds: [], headOperationIds }
    const whole = j.append('review.create', { ...input, id: 'whole' })
    j.append('review.create', { ...input, id: 'one', cellIds: ['one'] })
    j.append('review.create', { ...input, id: 'two', cellIds: ['two'] })
    const a = j.append(
      'review.create',
      { ...input, id: 'both-a', cellIds: ['two', 'one'] },
      { actorId: 'a', actorSequence: 1, dependencies: [whole.op_id] }
    )
    j.append(
      'review.create',
      { ...input, id: 'both-b', cellIds: ['one', 'two', 'one'] },
      { actorId: 'b', actorSequence: 1, dependencies: [whole.op_id] }
    )
    j.append(
      'review.submit',
      { reviewId: 'both-a', outcome: 'good_enough' },
      { actorId: 'a', actorSequence: 2, dependencies: [a.op_id] }
    )
    const rounds = buildReviewRounds(j.operations)
    expect(rounds).toHaveLength(4)
    expect(
      rounds
        .find((r) => r.id === 'one')
        ?.diff.cells.map((r) => r.compareCell?.refId)
    ).toEqual(['one'])
    expect(rounds.find((r) => r.cellIds?.length === 2)?.outcome).toBe(
      'good_enough'
    )
    expect(buildReviewRounds([...j.operations].reverse())).toEqual(rounds)
    j.append('review.create', { ...input, id: 'invalid', cellIds: ['missing'] })
    expect(() => buildReviewRounds(j.operations)).toThrow(
      'start or end revision'
    )
  })
  it('converges concurrent submissions without changing the frozen comparison', () => {
    const j = journal()
    j.seed()
    const creation = j.review('round')
    const initial = buildReviewRounds(j.operations)[0]
    const first = j.append(
      'review.submit',
      {
        reviewId: 'round',
        outcome: 'approve',
        summary: 'Ready',
        author: { displayName: 'Ada', kind: 'human' },
      },
      { actorId: 'alice', actorSequence: 1, dependencies: [creation.op_id] }
    )
    const second = j.append(
      'review.submit',
      {
        reviewId: 'round',
        outcome: 'request_changes',
        summary: 'One more check',
        author: { displayName: 'Bob', kind: 'human' },
      },
      { actorId: 'bob', actorSequence: 1, dependencies: [creation.op_id] }
    )
    expect(first.deps).toEqual(second.deps)
    const forward = buildReviewRounds(j.operations)[0]
    const reverse = buildReviewRounds([...j.operations].reverse())[0]
    expect(forward).toEqual(reverse)
    expect(forward.diff).toEqual(initial.diff)
    expect(forward.outcome).toBe('request_changes')
    expect(forward.submittedBy?.displayName).toBe('Bob')
  })

  it('does not treat extra create fields as a submitted review', () => {
    const j = journal()
    j.seed()
    j.append('review.create', {
      id: 'round',
      title: 'Round',
      baseOperationIds: [],
      headOperationIds: captureReviewRevision(j.operations),
      outcome: 'approve',
      summary: 'Not a submission',
    })
    const round = buildReviewRounds(j.operations)[0]
    expect(round.outcome).toBeUndefined()
    expect(round.summary).toBeUndefined()
  })

  it('keeps both endpoints fixed through later edits, submissions and rejection', () => {
    const j = journal()
    j.seed()
    j.review('round-1')
    const original = buildReviewRounds(j.operations)[0]
    const edit = j.append(
      'cell.update',
      { cell_id: 'one', cell: j.cell('Revised') },
      { suggestionId: 'edit' }
    )
    j.review('round-2', original.headOperationIds, original.id)
    const second = buildReviewRounds(j.operations)[1]
    expect(second.before.cells[0].value).toBe('Original')
    expect(second.after.cells[0].value).toBe('Revised')
    j.append('review.submit', {
      reviewId: 'round-2',
      outcome: 'approve',
      author: { displayName: 'Ada', kind: 'human' },
    })
    j.append(
      'suggestion.review',
      {
        suggestion_id: 'edit',
        decision: 'reject',
        operation_ids: [edit.op_id],
      },
      { reverts: [edit.op_id] }
    )
    expect(materializeOperationLog(j.operations).notebook.cells[0].value).toBe(
      'Original'
    )
    const rounds = buildReviewRounds(j.operations)
    expect(rounds[0]).toEqual(original)
    expect(rounds[1].diff).toEqual(second.diff)
    expect(rounds[1].outcome).toBe('approve')
    expect(rounds[1].submittedBy).toEqual({ displayName: 'Ada', kind: 'human' })
    expect(buildReviewRounds([...j.operations].reverse())).toEqual(rounds)
  })

  it('links one durable discussion to multiple rounds without copying messages', () => {
    const j = journal()
    j.seed()
    j.review('one')
    j.append('comment.add', {
      comment_id: 'thread',
      thread_id: 'thread',
      author: { principal_id: 'actor', display_name: 'Codex', kind: 'agent' },
      body: { format: 'text/markdown', value: 'Explain this' },
      annotation: { motivation: 'commenting', targets: [] },
    })
    j.append('review.link_thread', { reviewId: 'one', commentId: 'thread' })
    j.append('cell.update', { cell_id: 'one', cell: j.cell('Revised') })
    j.review('two', buildReviewRounds(j.operations)[0].headOperationIds, 'one')
    j.append('review.link_thread', { reviewId: 'two', commentId: 'thread' })
    j.append('review.link_thread', { reviewId: 'two', commentId: 'thread' })
    j.append('comment.reply', {
      comment_id: 'reply',
      thread_id: 'thread',
      parent_comment_id: 'thread',
      author: { principal_id: 'actor2', display_name: 'Ada' },
      body: { format: 'text/markdown', value: 'Addressed' },
      annotation: { motivation: 'commenting', targets: [] },
    })
    j.append('thread.set_status', { thread_id: 'thread', status: 'resolved' })
    expect(buildReviewRounds(j.operations).map((r) => r.threadIds)).toEqual([
      ['thread'],
      ['thread'],
    ])
    expect(materializeOperationLog(j.operations).comments).toHaveLength(2)
    expect(materializeOperationLog(j.operations).threadStatus.thread).toBe(
      'resolved'
    )
  })

  it('captures complete transactions and rejects a snapshot missing its commit', () => {
    const j = journal()
    const member = j.append(
      'cell.create',
      {
        cell_id: 'one',
        position: [[100, 'reviewer', 1]],
        cell: j.cell('Atomic'),
      },
      { transactionId: 'tx' }
    )
    expect(captureReviewRevision(j.operations)).toEqual([])
    j.append('transaction.commit', {
      transaction_id: 'tx',
      members: [member.op_id],
    })
    j.review('good')
    expect(buildReviewRounds(j.operations)[0].after.cells[0].value).toBe(
      'Atomic'
    )
    j.append('review.create', {
      id: 'bad',
      title: 'bad',
      baseOperationIds: [],
      headOperationIds: [member.op_id],
    })
    expect(() => buildReviewRounds(j.operations)).toThrow(
      'uncommitted transaction'
    )
  })

  it('rejects snapshots referencing operations not observed by the creator', () => {
    const j = journal()
    const seed = j.seed()
    const future = j.append('cell.update', {
      cell_id: 'one',
      cell: j.cell('Future'),
    })
    j.append(
      'review.create',
      {
        id: 'bad',
        title: 'bad',
        baseOperationIds: [],
        headOperationIds: [seed.op_id, future.op_id],
      },
      { actorId: 'other', actorSequence: 1, dependencies: [seed.op_id] }
    )
    expect(() => buildReviewRounds(j.operations)).toThrow('future operations')
  })

  it('rejects concurrent thread references even if the root sorts before the link', () => {
    const j = journal()
    j.seed()
    const review = j.review('one')
    j.append('comment.add', { comment_id: 'thread', thread_id: 'thread' })
    j.append(
      'review.link_thread',
      { reviewId: 'one', commentId: 'thread' },
      { actorId: 'z', actorSequence: 1, dependencies: [review.op_id] }
    )
    expect(() => buildReviewRounds(j.operations)).toThrow(
      'Review thread not found'
    )
  })

  it('defaults missing and blank attribution to unknown and rejects invalid kinds', () => {
    expect(normalizeAttribution()).toEqual({
      displayName: 'unknown',
      kind: 'unknown',
    })
    expect(normalizeAttribution({ displayName: '  ', kind: 'agent' })).toEqual({
      displayName: 'unknown',
      kind: 'unknown',
    })
    expect(
      normalizeAttribution({ displayName: ' Codex ', kind: 'agent' })
    ).toEqual({ displayName: 'Codex', kind: 'agent' })
    expect(() =>
      normalizeAttribution({ displayName: 'Codex', kind: 'admin' as never })
    ).toThrow('Invalid author kind')
  })
})
