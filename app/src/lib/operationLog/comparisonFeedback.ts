import type LocalNotebooks from '../../storage/local'
import {
  type DiffCommentTarget,
  createDiffCommentTarget,
} from './diffCommentAnchor'
import { type Attribution, createReviewAnchor } from './reviews'

/** Public comparison identity: browsing is read-only; feedback freezes this scope. */
export type ComparisonSelection = {
  startRevisionId: string
  endRevisionId: string
  cellIds?: string[]
}
export type ComparisonComment = ComparisonSelection & {
  content: string
  cellId?: string
  side?: 'base' | 'head'
  sourceRange?: DiffCommentTarget['sourceRange']
  author?: Attribution
}
export type ComparisonAssessment = ComparisonSelection & {
  outcome: 'good_enough' | 'needs_more_work'
  author?: Attribution
}

/** Validate before writing. Reuse the journal's canonical pair/scope identity,
 * without making the caller create or submit a review first. Snapshot validation
 * prevents a source selection from silently moving to a newer live revision.
 */
export async function commentOnComparison(
  store: LocalNotebooks,
  uri: string,
  input: ComparisonComment
) {
  if (typeof input.content !== 'string' || !input.content.trim())
    throw new Error('Comment must not be empty')
  if (!input.cellId && (input.side || input.sourceRange))
    throw new Error('A diff side or range requires a cell ID')
  const selection: ComparisonSelection = {
    startRevisionId: input.startRevisionId,
    endRevisionId: input.endRevisionId,
    cellIds: input.cellIds,
  }
  const preview = await store.previewNotebookReview(uri, selection)
  const target = input.cellId
    ? createDiffCommentTarget(
        preview.diff.cells,
        input.cellId,
        input.side,
        input.sourceRange
      )
    : undefined
  const record = await store.createNotebookReview(uri, {
    ...selection,
    author: input.author,
  })
  return store.addOperationLogComment(uri, {
    content: input.content,
    author: input.author,
    anchor: createReviewAnchor(
      record.id,
      target?.cellId,
      target?.quote,
      target
    ),
  })
}

/** An assessment records feedback only; it never undoes edits or resolves threads. */
export async function assessComparison(
  store: LocalNotebooks,
  uri: string,
  input: ComparisonAssessment
) {
  if (!['good_enough', 'needs_more_work'].includes(input.outcome))
    throw new Error('Invalid comparison assessment')
  const record = await store.createNotebookReview(uri, {
    startRevisionId: input.startRevisionId,
    endRevisionId: input.endRevisionId,
    cellIds: input.cellIds,
    author: input.author,
  })
  await store.submitNotebookReview(uri, {
    reviewId: record.id,
    outcome: input.outcome,
    author: input.author,
  })
  return { comparisonId: record.id, outcome: input.outcome }
}
