import type { JsonValue, RunmeOperation } from './types'

/** Content identity excludes checkpoints, comments, labels and status events. */
export function changesNotebook(op: RunmeOperation): boolean {
  return (
    /^(cell\.|notebook\.|execution\.)/.test(op.kind) ||
    op.kind === 'suggestion.review'
  )
}

/** V2 records share identity and causality, but are separate JSONL entities. */
export interface CausalRecord {
  format_version: 2
  op_id: string
  actor_id: string
  actor_seq: number
  lamport: number
  deps: string[]
  created_at: string
  transaction_id?: string
}

export interface Attribution {
  displayName: string
  kind: 'human' | 'agent' | 'service-account' | 'unknown'
  source?: 'google-drive'
  authenticatedPrincipal?: string
}

export type VersionRef =
  | { kind: 'operation'; op_id: string }
  | { kind: 'revision'; revision_id: string }

export interface RevisionRecord extends CausalRecord {
  record_type: 'runme.revision'
  snapshot_heads: string[]
  name?: string
  description?: string
  author: Attribution
}

export interface SourceRange {
  start_index: number
  end_index: number
  unit: 'unicode-code-point'
}

export type Anchor =
  | { kind: 'notebook'; version: VersionRef }
  | {
      kind: 'cell'
      cell_id: string
      version: VersionRef
      surface: 'source'
      range?: SourceRange
    }

export interface ComparisonContext {
  start: VersionRef
  end: VersionRef
  cell_ids?: string[]
}

/** Assessments belong to a message, never to a separate Review entity. */
export type Assessment =
  | { kind: 'scope'; outcome: 'good_enough' | 'needs_more_work' }
  | { kind: 'cell'; cell_id: string; decision: 'accept' | 'undo' }

export interface CommentRecord extends CausalRecord {
  record_type: 'runme.comment'
  thread_id: string
  parent_comment_id?: string
  author: Attribution
  body: { format: 'text/markdown'; value: string }
  anchors?: Anchor[]
  comparison?: ComparisonContext
  assessment?: Assessment
}

export type NotebookRecord = RevisionRecord | CommentRecord | RunmeOperation

/** Internal operation dispatch is a projection, not the serialized wire shape.
 * Keeping this adapter at the codec boundary lets the existing cell/execution
 * reducers share causal ordering with first-class revision/comment records.
 */
export function projectRecord(
  record: RevisionRecord | CommentRecord
): RunmeOperation {
  const {
    record_type,
    format_version,
    op_id,
    actor_id,
    actor_seq,
    lamport,
    deps,
    created_at,
    transaction_id,
    ...payload
  } = record
  return {
    record_type: 'runme.operation',
    format_version,
    op_id,
    actor_id,
    actor_seq,
    lamport,
    deps,
    created_at,
    ...(transaction_id ? { transaction_id } : {}),
    kind:
      record_type === 'runme.revision'
        ? 'revision.checkpoint'
        : 'comment.record',
    payload: payload as unknown as JsonValue,
  }
}

/** Flatten only new entity dispatches. Legacy records remain byte-semantically
 * unchanged so reading or synchronizing an old notebook is not a migration.
 */
export function serializedRecord(op: RunmeOperation): NotebookRecord {
  if (!['revision.checkpoint', 'comment.record'].includes(op.kind)) return op
  const { kind, payload, record_type: _type, ...causal } = op
  return {
    ...causal,
    ...(payload as object),
    record_type:
      kind === 'revision.checkpoint' ? 'runme.revision' : 'runme.comment',
  } as RevisionRecord | CommentRecord
}

/** Attribution is a supplied label; it never grants authentication or ownership. */
export function normalizeAttribution(
  author?: Attribution,
  preserveIdentity = false
): Attribution {
  if (!author?.displayName?.trim())
    return { displayName: 'unknown', kind: 'unknown' }
  if (!['human', 'agent', 'service-account', 'unknown'].includes(author.kind))
    throw new Error('Invalid author kind')
  return {
    displayName: author.displayName.trim(),
    kind: author.kind,
    ...(preserveIdentity &&
    author.source === 'google-drive' &&
    author.authenticatedPrincipal
      ? {
          source: 'google-drive' as const,
          authenticatedPrincipal: author.authenticatedPrincipal,
        }
      : {}),
  }
}
