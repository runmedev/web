import type LocalNotebooks from '../../storage/local'
import { OperationLogMutationCommitUncertainError } from '../../storage/local'
import type { NotebookDataLike } from '../runtime/runmeConsole'
import { parseOperationLog } from './codec'
import {
  type DiffCommentTarget,
  createDiffCommentTarget,
} from './diffCommentAnchor'
import { materializeOperationLog } from './materialize'
import { materializedLogToNotebook } from './notebook'
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
export type ComparisonCellDecision = ComparisonSelection & {
  cellId: string
  decision: 'accept' | 'undo'
  author?: Attribution
}

/** Cell acceptance affects presentation; undo appends a guarded inverse. */
export async function decideComparisonCell(
  store: LocalNotebooks,
  uri: string,
  input: ComparisonCellDecision,
  notebook?: Partial<NotebookDataLike>
) {
  if (!['accept', 'undo'].includes(input.decision))
    throw new Error('Invalid cell decision')
  if (
    notebook?.isReadOnly?.() ||
    notebook?.isReleasePending?.() ||
    notebook?.isReviewPending?.()
  )
    throw new Error('Notebook is read-only or busy')
  const undo = input.decision === 'undo'
  if (undo && notebook?.hasActiveExecutions?.())
    throw new Error(
      'Wait for running cells to finish before undoing a cell change'
    )
  if (
    undo &&
    notebook &&
    (!notebook.setNotebookStore ||
      !notebook.loadNotebook ||
      !notebook.setReviewPending)
  )
    throw new Error('Editor does not support safe cell undo')
  let committed = false
  let reloaded = false
  if (undo) notebook?.setReviewPending?.(true)
  try {
    if (undo)
      await notebook?.cancelActiveExecutions?.(
        'Execution cancelled because a cell change is being undone.\n'
      )
    await notebook?.flushPendingPersist?.()
    const preview = await store.previewNotebookReview(uri, input)
    if (
      !preview.diff.cells.some(
        (row) =>
          (row.compareCell ?? row.baseCell)?.refId === input.cellId &&
          row.kind !== 'unchanged'
      )
    )
      throw new Error('Changed cell not found in comparison scope')
    const record = await store.createNotebookReview(uri, input)
    await store.decideNotebookReviewCell(uri, {
      reviewId: record.id,
      cellId: input.cellId,
      decision: input.decision,
      author: input.author,
    })
    committed = true
    if (undo && notebook) {
      const content = await store.loadContent(uri)
      notebook.setNotebookStore!(
        await store.createOperationLogSaveStore(uri, {
          initialDocument: content,
        })
      )
      notebook.loadNotebook!(
        materializedLogToNotebook(
          materializeOperationLog(parseOperationLog(content).operations)
        ),
        { persist: false }
      )
      notebook.setReviewReloadRequired?.(false)
    }
    reloaded = true
    return {
      comparisonId: record.id,
      cellId: input.cellId,
      decision: input.decision,
    }
  } catch (error) {
    if (
      undo &&
      (committed || error instanceof OperationLogMutationCommitUncertainError)
    ) {
      committed = true
      notebook?.setReviewReloadRequired?.(true)
      throw new Error(
        `Cell decision may be saved but the editor could not reload. Use the notebook tab's Refresh button before editing. ${String(error)}`
      )
    }
    throw error
  } finally {
    if (undo && (!committed || reloaded)) notebook?.setReviewPending?.(false)
  }
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
