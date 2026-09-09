import md5 from 'md5'

import { withCellReviewKeys } from './cellReviewIdentity'
import { buildReviewRounds } from './legacyReviews'
import { committedOperationIds, orderOperationSet } from './order'
import {
  type Attribution,
  type CommentRecord,
  type ComparisonContext,
  type VersionRef,
  serializedRecord,
} from './records'
import {
  computeReviewDiff,
  normalizeReviewCellIds,
  reviewIdentityKey,
} from './reviewScope'
import {
  buildNotebookRevisions,
  materializeRevision,
  notebookRevisionForVersion,
  revisionFollows,
  revisionKey,
} from './revisions'
import type { RunmeOperation } from './types'
import { resolveVersion } from './versions'

/** Pure preview: opening or changing a comparison never writes a record. */
export type ComparisonSelection =
  | {
      start: VersionRef
      end: VersionRef
      cell_ids?: string[]
    }
  | { startRevisionId: string; endRevisionId: string; cellIds?: string[] }

export function previewComparison(
  operations: RunmeOperation[],
  input: ComparisonSelection
) {
  const revisions = 'start' in input ? [] : buildNotebookRevisions(operations)
  const start =
    'start' in input
      ? notebookRevisionForVersion(operations, input.start)
      : revisions.find((r) => r.id === input.startRevisionId)
  const end =
    'end' in input
      ? notebookRevisionForVersion(operations, input.end)
      : revisions.find((r) => r.id === input.endRevisionId)
  if (!start || !end) throw new Error('Revision not found')
  if (!revisionFollows(start, end))
    throw new Error('End revision must be after start revision')
  const before = materializeRevision(operations, start.operationIds)
  const after = materializeRevision(operations, end.operationIds)
  const cellIds = normalizeReviewCellIds(
    'start' in input ? input.cell_ids : input.cellIds,
    before,
    after
  )
  return {
    start,
    end,
    before,
    after,
    cellIds,
    diff: withCellReviewKeys(
      computeReviewDiff(before, after, cellIds),
      operations,
      start.operationIds,
      end.operationIds
    ),
  }
}

/** A disposable projection of messages sharing a comparison, never a log entity. */
export interface NotebookComparison {
  id: string
  baseOperationIds: string[]
  headOperationIds: string[]
  cellIds?: string[]
  threadIds: string[]
  aliases?: string[]
  outcome?:
    | 'good_enough'
    | 'needs_more_work'
    | 'comment'
    | 'approve'
    | 'request_changes'
  cellDecisions: Array<{
    cellId: string
    decision: 'accept' | 'undo'
    operationId: string
    order: number
    author: Attribution
  }>
  before: ReturnType<typeof materializeRevision>
  after: ReturnType<typeof materializeRevision>
  diff: ReturnType<typeof computeReviewDiff>
}

/** Canonical content/scope identity tolerates labels and unrelated messages. */
export function comparisonKey(
  operations: RunmeOperation[],
  context: ComparisonContext
): string {
  const base = resolveVersion(operations, context.start).map((op) => op.op_id)
  const head = resolveVersion(operations, context.end).map((op) => op.op_id)
  return reviewIdentityKey(
    revisionKey(operations, base),
    revisionKey(operations, head),
    context.cell_ids
  )
}

/** Build conversation and decision projections directly from first-class messages.
 * V1 decoding is read-only compatibility until an explicit copy migration.
 */
export function buildComparisons(
  operations: RunmeOperation[]
): NotebookComparison[] {
  const migrated = operations.some((op) => op.kind === 'migration.v2')
  const legacy = migrated
    ? []
    : buildReviewRounds(operations).map((r) => ({
        ...r,
        cellDecisions: r.cellDecisions ?? [],
      }))
  const result = new Map<string, NotebookComparison>()
  const committed = committedOperationIds(operations)
  const ordered = orderOperationSet(operations).ordered.filter((op) =>
    committed.has(op.op_id)
  )
  const roots = new Map<string, CommentRecord>()
  for (const [order, op] of ordered.entries()) {
    if (op.kind !== 'comment.record') continue
    const record = serializedRecord(op) as CommentRecord
    if (!record.parent_comment_id) roots.set(record.thread_id, record)
    const root = roots.get(record.thread_id)
    const context = root?.comparison
    if (!context) continue
    const key = comparisonKey(operations, context)
    let comparison = result.get(key)
    if (!comparison) {
      const baseOperationIds = resolveVersion(operations, context.start).map(
        (op) => op.op_id
      )
      const headOperationIds = resolveVersion(operations, context.end).map(
        (op) => op.op_id
      )
      const before = materializeRevision(operations, baseOperationIds)
      const after = materializeRevision(operations, headOperationIds)
      const cellIds = normalizeReviewCellIds(context.cell_ids, before, after)
      comparison = {
        id: `comparison:${md5(key)}`,
        baseOperationIds,
        headOperationIds,
        cellIds,
        threadIds: [],
        cellDecisions: [],
        before,
        after,
        diff: withCellReviewKeys(
          computeReviewDiff(before, after, cellIds),
          operations,
          baseOperationIds,
          headOperationIds
        ),
      }
      result.set(key, comparison)
    }
    if (!comparison.threadIds.includes(record.thread_id))
      comparison.threadIds.push(record.thread_id)
    if (record.assessment?.kind === 'scope')
      comparison.outcome = record.assessment.outcome
    if (record.assessment?.kind === 'cell')
      comparison.cellDecisions.push({
        cellId: record.assessment.cell_id,
        decision: record.assessment.decision,
        author: record.author,
        operationId: op.op_id,
        order,
      })
  }
  return [...legacy, ...result.values()]
}
