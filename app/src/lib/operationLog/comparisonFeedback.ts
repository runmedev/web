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
import type { Anchor, Attribution, ComparisonContext } from './records'
import { codePointRange, snapshotHeads } from './versions'

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
    const preview = await store.previewNotebookComparison(uri, input)
    if (
      !preview.diff.cells.some(
        (row) =>
          (row.compareCell ?? row.baseCell)?.refId === input.cellId &&
          row.kind !== 'unchanged'
      )
    )
      throw new Error('Changed cell not found in comparison scope')
    const comparison = await freezeComparison(store, uri, input)
    await store.decideNotebookComparisonCell(uri, {
      startRevisionId:
        comparison.start.kind === 'revision'
          ? comparison.start.revision_id
          : '',
      endRevisionId:
        comparison.end.kind === 'revision' ? comparison.end.revision_id : '',
      cellIds: input.cellIds,
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
      comparison,
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
  const preview = await store.previewNotebookComparison(uri, selection)
  const target = input.cellId
    ? createDiffCommentTarget(
        preview.diff.cells,
        input.cellId,
        input.side,
        input.sourceRange
      )
    : undefined
  const comparison = await freezeComparison(store, uri, selection)
  const version = target?.side === 'base' ? comparison.start : comparison.end
  const source = (
    target?.side === 'base' ? preview.before : preview.after
  ).cells.find((c) => c.refId === input.cellId)?.value
  const anchors: Anchor[] = target
    ? [
        {
          kind: 'cell',
          cell_id: target.cellId,
          version,
          surface: 'source',
          ...(input.sourceRange
            ? {
                range: codePointRange(
                  source!,
                  input.sourceRange.start,
                  input.sourceRange.end
                ),
              }
            : {}),
        },
      ]
    : [
        { kind: 'notebook', version: comparison.start },
        { kind: 'notebook', version: comparison.end },
      ]
  return store.addAnchoredComment(uri, {
    content: input.content,
    author: input.author,
    anchors,
    comparison,
  })
}

/** Freeze only when feedback is written. Picker state itself never writes. */
async function freezeComparison(
  store: LocalNotebooks,
  uri: string,
  input: ComparisonSelection
): Promise<ComparisonContext> {
  const preview = await store.previewNotebookComparison(uri, input)
  const operations =
    preview.start.version?.kind === 'revision' &&
    preview.end.version?.kind === 'revision'
      ? []
      : parseOperationLog(await store.loadContent(uri)).operations
  const capture = async (revision: typeof preview.start) =>
    revision.version?.kind === 'revision'
      ? revision.version
      : store.checkpointNotebookRevision(uri, {
          snapshot_heads: snapshotHeads(operations, revision.operationIds),
        })
  return {
    start: await capture(preview.start),
    end: await capture(preview.end),
    ...(preview.cellIds ? { cell_ids: preview.cellIds } : {}),
  }
}

/** Assessments are messages, not mutable review submissions. */
export async function assessComparison(
  store: LocalNotebooks,
  uri: string,
  input: ComparisonAssessment
) {
  if (!['good_enough', 'needs_more_work'].includes(input.outcome))
    throw new Error('Invalid comparison assessment')
  const comparison = await freezeComparison(store, uri, input)
  return store.addAnchoredComment(uri, {
    content:
      input.outcome === 'good_enough' ? 'Good Enough' : 'Needs More Work',
    author: input.author,
    comparison,
    anchors: [
      { kind: 'notebook', version: comparison.start },
      { kind: 'notebook', version: comparison.end },
    ],
    assessment: { kind: 'scope', outcome: input.outcome },
  })
}
