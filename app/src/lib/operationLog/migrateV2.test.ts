import { describe, expect, it } from 'vitest'

import { parseOperationLog, serializeOperationLog } from './codec'
import { buildComparisons } from './comparisons'
import { createReviewAnchor } from './legacyReviews'
import { materializeOperationLog } from './materialize'
import { migrateOperationLogV2 } from './migrateV2'
import { causalHeads, createRunmeOperation } from './mutations'
import { type CommentRecord, serializedRecord } from './records'
import { buildNotebookRevisions } from './revisions'
import type { JsonValue, RunmeOperation } from './types'
import { anchorSource } from './versions'

const header = {
  record_type: 'runme.notebook' as const,
  format_version: 1 as const,
  notebook_id: 'original',
  created_by: 'test',
  created_at: '2026-09-01T00:00:00Z',
}
const author = { displayName: 'Ada', kind: 'human' }
function fixture() {
  const ops: RunmeOperation[] = []
  const add = (kind: string, payload: unknown) => {
    const op = createRunmeOperation({
      actorId: 'test',
      actorSequence: ops.length + 1,
      dependencies: causalHeads(ops),
      knownOperations: ops,
      kind,
      payload: payload as JsonValue,
      createdAt: `2026-09-01T00:00:${String(ops.length).padStart(2, '0')}Z`,
    })
    ops.push(op)
    return op
  }
  add('cell.create', {
    cell_id: 'c',
    position: [[100, 'test', 1]],
    cell: {
      kind: 'markup',
      language_id: 'markdown',
      value: 'A😀B',
      metadata: {},
    },
  })
  return { ops, add }
}

describe('explicit V1 copy migration', () => {
  it('preserves cells, replies, resolved state, labels, range quotes, and assessments', async () => {
    const { ops, add } = fixture()
    const ids = ops.map((op) => op.op_id)
    add('review.create', {
      id: 'review',
      title: 'Review',
      baseOperationIds: [],
      headOperationIds: ids,
      author,
    })
    add('revision.label', {
      revisionId: buildNotebookRevisions(ops).at(-1)!.id,
      operationIds: ids,
      name: 'Approved',
      description: 'Old snapshot',
      author,
    })
    add('comment.add', {
      comment_id: 'root',
      thread_id: 'root',
      author: { principal_id: 'Ada', display_name: 'Ada', kind: 'human' },
      body: { format: 'text/markdown', value: 'Emoji?' },
      annotation: {
        motivation: 'commenting',
        targets: [
          {
            anchor: createReviewAnchor('review', 'c', '😀', {
              cellId: 'c',
              side: 'head',
              quote: '😀',
              sourceRange: { start: 1, end: 3, unit: 'utf-16' },
            }),
          },
        ],
      },
    })
    add('comment.reply', {
      comment_id: 'reply',
      thread_id: 'root',
      parent_comment_id: 'root',
      author: { principal_id: 'Codex', display_name: 'Codex', kind: 'agent' },
      body: { format: 'text/markdown', value: 'Yes.' },
      annotation: { motivation: 'commenting', targets: [] },
    })
    add('thread.set_status', { thread_id: 'root', status: 'resolved' })
    add('review.submit', {
      reviewId: 'review',
      outcome: 'good_enough',
      summary: '',
      author,
    })
    add('review.cell_decision', {
      reviewId: 'review',
      cellId: 'c',
      decision: 'accept',
      author,
    })
    const original = serializeOperationLog(header, ops)
    const result = await migrateOperationLogV2(original, 'copy')
    expect(result.warnings).toEqual([])
    const parsed = parseOperationLog(result.document!)
    expect(parsed.header).toMatchObject({
      format_version: 2,
      notebook_id: 'copy',
    })
    expect(parsed.operations.slice(0, ops.length)).toEqual(ops)
    expect(serializeOperationLog(header, ops)).toBe(original)
    const projected = materializeOperationLog(parsed.operations)
    expect(projected.notebook).toEqual(materializeOperationLog(ops).notebook)
    const root = projected.comments.find(
      (c) => c.comment_id === result.commentIds!.root
    )!
    const native = serializedRecord(
      parsed.operations.find((op) => op.op_id === root.operation_id)!
    ) as CommentRecord
    expect(native.anchors![0]).toMatchObject({
      range: { start_index: 1, end_index: 2, unit: 'unicode-code-point' },
    })
    expect(native.anchors![0]).not.toHaveProperty('quote')
    expect(anchorSource(parsed.operations, native.anchors![0])).toBe('😀')
    expect(
      projected.comments.find((c) => c.comment_id === result.commentIds!.reply)
        ?.parent_comment_id
    ).toBe(root.comment_id)
    expect(projected.threadStatus[root.thread_id]).toBe('resolved')
    expect(
      buildNotebookRevisions(parsed.operations).some(
        (r) => r.name === 'Approved'
      )
    ).toBe(true)
    expect(buildComparisons(parsed.operations)).toHaveLength(1)
    expect(buildComparisons(parsed.operations)[0]).toMatchObject({
      outcome: 'good_enough',
      cellDecisions: [{ cellId: 'c', decision: 'accept' }],
    })
  })
  it('reports an unconvertible anchor instead of dropping feedback', async () => {
    const { ops, add } = fixture()
    add('comment.add', {
      comment_id: 'root',
      thread_id: 'root',
      author: { principal_id: 'Ada', display_name: 'Ada' },
      body: { format: 'text/markdown', value: 'Keep this' },
      annotation: {
        motivation: 'commenting',
        targets: [
          {
            anchor: JSON.stringify({
              runme: { type: 'cell', cellId: 'c', quote: 'wrong source' },
            }),
          },
        ],
      },
    })
    const result = await migrateOperationLogV2(
      serializeOperationLog(header, ops),
      'copy'
    )
    expect(result.document).toBeUndefined()
    expect(result.warnings[0]).toContain('root')
  })
  it('refuses in-place conversion and partial transactions', async () => {
    const { ops } = fixture()
    await expect(
      migrateOperationLogV2(serializeOperationLog(header, ops), 'original')
    ).rejects.toThrow('new notebook identity')
    ops[0].transaction_id = 'unfinished'
    expect(
      (await migrateOperationLogV2(serializeOperationLog(header, ops), 'copy'))
        .document
    ).toBeUndefined()
  })
})
