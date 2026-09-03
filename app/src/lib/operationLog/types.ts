export const RUNME_OPERATION_LOG_FORMAT_VERSION = 1 as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface NotebookLogHeader {
  record_type: 'runme.notebook'
  format_version: typeof RUNME_OPERATION_LOG_FORMAT_VERSION
  notebook_id: string
  created_by: string
  created_at: string
}

export type PositionComponent = readonly [
  digit: number,
  actorId: string,
  actorSequence: number,
]
export type PositionId = readonly PositionComponent[]

export interface OperationCell {
  kind: 'code' | 'markup'
  language_id: string
  value: string
  metadata: Record<string, JsonValue>
  /** Lossless protobuf JSON for fields outside the operation-log core. */
  proto_json?: Record<string, JsonValue>
}

export interface CellCreatePayload {
  cell_id: string
  position: PositionId
  cell: OperationCell
}

export interface CellUpdatePayload {
  cell_id: string
  cell: OperationCell
}

export interface CellMovePayload {
  cell_id: string
  position: PositionId
}

export interface CellIdentityPayload {
  cell_id: string
}

export interface CellRestorePayload extends CellIdentityPayload {
  position?: PositionId
}

export interface CellClearOutputsPayload extends CellIdentityPayload {
  reason: string
}

export interface ExecutionStartPayload {
  execution_id: string
  cell_id: string
  source_op_id: string
  input: {
    language_id: string
    value: string
    execution_metadata: Record<string, JsonValue>
  }
  input_sha256: string
  runner: {
    runner_id: string
    runtime: string
    runtime_version: string
    environment_digest: string | null
  }
  started_at: string
}

export type ExecutionStatus = 'succeeded' | 'failed' | 'cancelled' | 'lost'

export interface ExecutionFinishPayload {
  execution_id: string
  status: ExecutionStatus
  outputs: JsonValue[]
  execution_summary: Record<string, JsonValue>
  finished_at: string
}

export interface TransactionCommitPayload {
  transaction_id: string
  members: string[]
}

export interface NotebookUpdatePayload {
  frontmatter: Record<string, JsonValue>
  metadata: Record<string, JsonValue>
}

export interface CommentBody {
  format: 'text/markdown'
  value: string
}

export interface CommentAuthor {
  principal_id: string
  display_name: string
}

export interface CommentAnnotation {
  motivation: 'commenting' | 'suggesting' | 'assessing' | 'evidencing'
  decision?: 'accept' | 'reject' | null
  targets: JsonValue[]
  evidence?: JsonValue[]
}

export interface CommentAddPayload {
  comment_id: string
  thread_id: string
  author: CommentAuthor
  body: CommentBody
  annotation: CommentAnnotation
}

export interface CommentReplyPayload extends CommentAddPayload {
  parent_comment_id: string
}

export interface ThreadSetStatusPayload {
  thread_id: string
  status: 'open' | 'resolved'
}

export type KnownOperationKind =
  | 'transaction.commit'
  | 'notebook.update'
  | 'cell.create'
  | 'cell.update'
  | 'cell.move'
  | 'cell.delete'
  | 'cell.restore'
  | 'cell.clear_outputs'
  | 'execution.start'
  | 'execution.finish'
  | 'comment.add'
  | 'comment.reply'
  | 'thread.set_status'

export interface RunmeOperation<
  Kind extends string = string,
  Payload = JsonValue,
> {
  record_type: 'runme.operation'
  format_version: typeof RUNME_OPERATION_LOG_FORMAT_VERSION
  op_id: string
  actor_id: string
  actor_seq: number
  lamport: number
  deps: string[]
  transaction_id?: string
  reverts?: string[]
  created_at: string
  kind: Kind
  payload: Payload
}

export interface ParsedOperationLog {
  header: NotebookLogHeader
  operations: RunmeOperation[]
}

export interface OrderedOperationSet {
  ordered: RunmeOperation[]
  pending: RunmeOperation[]
}
