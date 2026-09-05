import type { parser_pb } from '../../runme/client'
import { computeNotebookDiff } from '../notebookDiff/diff'
import type { CellDiff, NotebookDiff } from '../notebookDiff/model'
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
  'cell.clear_outputs',
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

export type InlineDiffKind = 'equal' | 'inserted' | 'deleted'

export interface InlineDiffSegment {
  kind: InlineDiffKind
  value: string
}

interface SuggestionAnchor {
  runme: {
    version: 1
    type: 'suggestion'
    suggestionId: string
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
  const suggestions = [...groups.entries()].map(([id, group]) => {
    const firstIndex = Math.min(
      ...group.map((operation) =>
        ordered.findIndex((candidate) => candidate.op_id === operation.op_id)
      )
    )
    const beforeOperations = ordered.slice(0, firstIndex)
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

function tokens(value: string): string[] {
  return value.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? []
}

function appendSegment(
  segments: InlineDiffSegment[],
  kind: InlineDiffKind,
  value: string
): void {
  if (!value) return
  const previous = segments.at(-1)
  if (previous?.kind === kind) {
    previous.value += value
    return
  }
  segments.push({ kind, value })
}

/** Compute a whitespace-preserving word diff suitable for inline cell review. */
export function diffInlineText(
  before: string,
  after: string
): InlineDiffSegment[] {
  if (before === after) return before ? [{ kind: 'equal', value: before }] : []
  const left = tokens(before)
  const right = tokens(after)
  if (left.length > 400 || right.length > 400) {
    return [
      ...(before ? [{ kind: 'deleted' as const, value: before }] : []),
      ...(after ? [{ kind: 'inserted' as const, value: after }] : []),
    ]
  }
  const table = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0)
  )
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i] === right[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const segments: InlineDiffSegment[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      appendSegment(segments, 'equal', left[i])
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      appendSegment(segments, 'deleted', left[i])
      i += 1
    } else {
      appendSegment(segments, 'inserted', right[j])
      j += 1
    }
  }
  while (i < left.length) appendSegment(segments, 'deleted', left[i++])
  while (j < right.length) appendSegment(segments, 'inserted', right[j++])
  return segments
}

/** Encode a comment target owned by one operation-log suggestion. */
export function createSuggestionCommentAnchor(suggestionId: string): string {
  const anchor: SuggestionAnchor = {
    runme: { version: 1, type: 'suggestion', suggestionId },
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
