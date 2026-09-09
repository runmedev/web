import type { parser_pb } from '../../runme/client'
import { computeNotebookDiff } from '../notebookDiff/diff'
import type { CellDiff, NotebookDiff } from '../notebookDiff/model'
import type { DiffCommentTarget } from './diffCommentAnchor'
import { materializeOperationLog } from './materialize'
import { materializedLogToNotebook } from './notebook'
import { committedOperationIds, orderOperationSet } from './order'
import type {
  RunmeOperation,
  SuggestionDecision,
  TransactionCommitPayload,
} from './types'

const SUGGESTIBLE_KINDS = new Set([
  'notebook.update',
  'cell.create',
  'cell.update',
  'cell.move',
  'cell.delete',
  'cell.restore',
])

export interface OperationLogSuggestion {
  id: string
  actorId: string
  createdAt: string
  operationIds: string[]
  operations: RunmeOperation[]
  decision?: SuggestionDecision
  before: parser_pb.Notebook
  proposed: parser_pb.Notebook
  diff: NotebookDiff
  changedCells: CellDiff[]
}

export { diffInlineText } from './inlineDiff'
export type { InlineDiffKind, InlineDiffSegment } from './inlineDiff'

interface SuggestionAnchor {
  runme: {
    version: 1
    type: 'suggestion'
    suggestionId: string
    diffTarget?: DiffCommentTarget
  }
}

/** Return whether an operation changes authored notebook state. */
export function isSuggestibleOperation(operation: RunmeOperation): boolean {
  return SUGGESTIBLE_KINDS.has(operation.kind)
}

function suggestionId(operation: RunmeOperation): string {
  return (
    operation.suggestion_id ??
    operation.transaction_id ??
    `legacy:${operation.op_id}`
  )
}

/**
 * Reconstruct reviewable before/proposed snapshots for authored operation groups.
 *
 * Legacy operations without grouping metadata remain reviewable as one-operation
 * suggestions. A group is compared in the causal context visible before its
 * first member, so concurrent operations never become part of the suggestion.
 */
export function buildOperationLogSuggestions(
  operations: RunmeOperation[]
): OperationLogSuggestion[] {
  const orderedSet = orderOperationSet(operations)
  const committed = committedOperationIds(operations)
  const ordered = orderedSet.ordered.filter((operation) =>
    committed.has(operation.op_id)
  )
  const groups = new Map<string, RunmeOperation[]>()
  for (const operation of ordered) {
    if (!isSuggestibleOperation(operation)) continue
    const id = suggestionId(operation)
    groups.set(id, [...(groups.get(id) ?? []), operation])
  }

  const current = materializeOperationLog(operations)
  const orderedById = new Map(
    ordered.map((operation) => [operation.op_id, operation] as const)
  )
  const suggestions = [...groups.entries()].map(([id, group]) => {
    const ancestorIds = new Set<string>()
    const pending = [...group[0].deps]
    while (pending.length > 0) {
      const dependencyId = pending.pop()!
      if (ancestorIds.has(dependencyId)) continue
      ancestorIds.add(dependencyId)
      const dependency = orderedById.get(dependencyId)
      if (dependency) pending.push(...dependency.deps)
    }
    const beforeOperations = ordered.filter((operation) =>
      ancestorIds.has(operation.op_id)
    )
    const before = materializedLogToNotebook(
      materializeOperationLog(beforeOperations)
    )
    const transactionIds = new Set(
      group.flatMap((operation) =>
        operation.transaction_id ? [operation.transaction_id] : []
      )
    )
    // A transaction member is not materializable without every member and its
    // commit operation. Include that transaction envelope in legacy previews
    // while still excluding unrelated concurrent operations.
    const proposalGroup =
      transactionIds.size === 0
        ? group
        : ordered.filter((operation) => {
            if (
              operation.transaction_id &&
              transactionIds.has(operation.transaction_id)
            ) {
              return true
            }
            if (operation.kind !== 'transaction.commit') return false
            const payload =
              operation.payload as unknown as TransactionCommitPayload
            return transactionIds.has(payload.transaction_id)
          })
    const proposed = materializedLogToNotebook(
      materializeOperationLog([...beforeOperations, ...proposalGroup])
    )
    const diff = computeNotebookDiff(before, proposed, {
      includeMetadata: true,
      includeOutputs: false,
    })
    return {
      id,
      actorId: group[0].actor_id,
      createdAt: group[0].created_at,
      operationIds: group.map((operation) => operation.op_id),
      operations: group,
      decision: current.suggestionReviews[id]?.decision,
      before,
      proposed,
      diff,
      changedCells: diff.cells.filter((cell) => cell.kind !== 'unchanged'),
    }
  })
  // Execution state is persisted both as execution records and, for editor
  // resume, as transient cell metadata. A metadata-only cell.update is not an
  // authored notebook change and would render as an empty suggestion.
  return suggestions.filter(
    (suggestion) =>
      suggestion.changedCells.length > 0 ||
      !suggestion.operations.every(
        (operation) => operation.kind === 'cell.update'
      )
  )
}

/** Encode a comment target owned by one operation-log suggestion. */
export function createSuggestionCommentAnchor(
  suggestionId: string,
  diffTarget?: DiffCommentTarget
): string {
  const anchor: SuggestionAnchor = {
    runme: {
      version: 1,
      type: 'suggestion',
      suggestionId,
      ...(diffTarget ? { diffTarget } : {}),
    },
  }
  return JSON.stringify(anchor)
}

/** Decode suggestion comment anchors while ignoring unrelated comment targets. */
export function parseSuggestionCommentAnchor(
  anchor: string | undefined
): string | null {
  if (!anchor) return null
  try {
    const value = JSON.parse(anchor) as Partial<SuggestionAnchor>
    return value.runme?.type === 'suggestion' &&
      typeof value.runme.suggestionId === 'string'
      ? value.runme.suggestionId
      : null
  } catch {
    return null
  }
}
