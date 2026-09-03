import { committedOperationIds, orderOperationSet } from './order'
import { comparePositionIds, validatePositionId } from './positions'
import type {
  CellCreatePayload,
  CellIdentityPayload,
  CellMovePayload,
  CellRestorePayload,
  CellUpdatePayload,
  CommentAddPayload,
  CommentReplyPayload,
  ExecutionFinishPayload,
  ExecutionStartPayload,
  JsonValue,
  NotebookUpdatePayload,
  OperationCell,
  PositionId,
  RunmeOperation,
  ThreadSetStatusPayload,
} from './types'

interface Register<T> {
  value: T
  operationId: string
}

interface CellRegisters {
  content?: Register<OperationCell>
  position?: Register<PositionId>
  visible?: Register<boolean>
  outputs?: Register<{
    outputs: JsonValue[]
    executionId?: string
    sourceOperationId?: string
  }>
}

export interface MaterializedCell extends OperationCell {
  cell_id: string
  position: PositionId
  source_operation_id: string
  outputs: JsonValue[]
  output_execution_id?: string
  outputs_stale: boolean
}

export interface MaterializedExecution {
  execution_id: string
  start: ExecutionStartPayload
  finish?: ExecutionFinishPayload
  start_operation_id: string
  finish_operation_id?: string
}

export interface MaterializedComment {
  comment_id: string
  thread_id: string
  parent_comment_id?: string
  payload: CommentAddPayload | CommentReplyPayload
  operation_id: string
}

export interface MaterializedOperationLog {
  notebook: {
    frontmatter: Record<string, JsonValue>
    metadata: Record<string, JsonValue>
    cells: MaterializedCell[]
  }
  comments: MaterializedComment[]
  threadStatus: Record<string, 'open' | 'resolved'>
  executions: MaterializedExecution[]
  orderedOperationIds: string[]
  pendingOperationIds: string[]
  unknownOperationIds: string[]
}

const knownKinds = new Set([
  'transaction.commit',
  'notebook.update',
  'cell.create',
  'cell.update',
  'cell.move',
  'cell.delete',
  'cell.restore',
  'cell.clear_outputs',
  'execution.start',
  'execution.finish',
  'comment.add',
  'comment.reply',
  'thread.set_status',
])

export function materializeOperationLog(
  operations: RunmeOperation[]
): MaterializedOperationLog {
  const ordered = orderOperationSet(operations)
  const committed = committedOperationIds(operations)
  const cells = new Map<string, CellRegisters>()
  const executionStarts = new Map<
    string,
    { payload: ExecutionStartPayload; operationId: string }
  >()
  const executionFinishes = new Map<
    string,
    { payload: ExecutionFinishPayload; operationId: string }
  >()
  const comments: MaterializedComment[] = []
  const threadStatus = new Map<string, Register<'open' | 'resolved'>>()
  const unknownOperationIds: string[] = []
  let notebookState: Register<NotebookUpdatePayload> | undefined

  const registersFor = (cellId: string): CellRegisters => {
    const existing = cells.get(cellId)
    if (existing) return existing
    const created: CellRegisters = {}
    cells.set(cellId, created)
    return created
  }

  for (const operation of ordered.ordered) {
    if (!committed.has(operation.op_id)) continue
    if (!knownKinds.has(operation.kind)) {
      unknownOperationIds.push(operation.op_id)
      continue
    }

    switch (operation.kind) {
      case 'transaction.commit':
        break
      case 'notebook.update':
        notebookState = {
          value: operation.payload as unknown as NotebookUpdatePayload,
          operationId: operation.op_id,
        }
        break
      case 'cell.create': {
        const payload = operation.payload as unknown as CellCreatePayload
        validatePositionId(payload.position)
        const registers = registersFor(payload.cell_id)
        if (registers.content) {
          throw new Error(
            `Cell ${payload.cell_id} has more than one cell.create`
          )
        }
        registers.content = {
          value: payload.cell,
          operationId: operation.op_id,
        }
        registers.position = {
          value: payload.position,
          operationId: operation.op_id,
        }
        registers.visible = { value: true, operationId: operation.op_id }
        registers.outputs = {
          value: { outputs: [] },
          operationId: operation.op_id,
        }
        break
      }
      case 'cell.update': {
        const payload = operation.payload as unknown as CellUpdatePayload
        registersFor(payload.cell_id).content = {
          value: payload.cell,
          operationId: operation.op_id,
        }
        break
      }
      case 'cell.move': {
        const payload = operation.payload as unknown as CellMovePayload
        validatePositionId(payload.position)
        registersFor(payload.cell_id).position = {
          value: payload.position,
          operationId: operation.op_id,
        }
        break
      }
      case 'cell.delete': {
        const payload = operation.payload as unknown as CellIdentityPayload
        registersFor(payload.cell_id).visible = {
          value: false,
          operationId: operation.op_id,
        }
        break
      }
      case 'cell.restore': {
        const payload = operation.payload as unknown as CellRestorePayload
        const registers = registersFor(payload.cell_id)
        registers.visible = { value: true, operationId: operation.op_id }
        if (payload.position) {
          validatePositionId(payload.position)
          registers.position = {
            value: payload.position,
            operationId: operation.op_id,
          }
        }
        break
      }
      case 'cell.clear_outputs': {
        const payload = operation.payload as unknown as CellIdentityPayload
        registersFor(payload.cell_id).outputs = {
          value: { outputs: [] },
          operationId: operation.op_id,
        }
        break
      }
      case 'execution.start': {
        const payload = operation.payload as unknown as ExecutionStartPayload
        if (executionStarts.has(payload.execution_id)) {
          throw new Error(
            `Execution ${payload.execution_id} has more than one start`
          )
        }
        executionStarts.set(payload.execution_id, {
          payload,
          operationId: operation.op_id,
        })
        break
      }
      case 'execution.finish': {
        const payload = operation.payload as unknown as ExecutionFinishPayload
        if (executionFinishes.has(payload.execution_id)) {
          throw new Error(
            `Execution ${payload.execution_id} has more than one finish`
          )
        }
        const start = executionStarts.get(payload.execution_id)
        if (!start) {
          throw new Error(
            `Execution ${payload.execution_id} finished before its start`
          )
        }
        executionFinishes.set(payload.execution_id, {
          payload,
          operationId: operation.op_id,
        })
        registersFor(start.payload.cell_id).outputs = {
          value: {
            outputs: payload.outputs,
            executionId: payload.execution_id,
            sourceOperationId: start.payload.source_op_id,
          },
          operationId: operation.op_id,
        }
        break
      }
      case 'comment.add': {
        const payload = operation.payload as unknown as CommentAddPayload
        comments.push({
          comment_id: payload.comment_id,
          thread_id: payload.thread_id,
          payload,
          operation_id: operation.op_id,
        })
        break
      }
      case 'comment.reply': {
        const payload = operation.payload as unknown as CommentReplyPayload
        comments.push({
          comment_id: payload.comment_id,
          thread_id: payload.thread_id,
          parent_comment_id: payload.parent_comment_id,
          payload,
          operation_id: operation.op_id,
        })
        break
      }
      case 'thread.set_status': {
        const payload = operation.payload as unknown as ThreadSetStatusPayload
        threadStatus.set(payload.thread_id, {
          value: payload.status,
          operationId: operation.op_id,
        })
        break
      }
    }
  }

  const visibleCells: MaterializedCell[] = []
  for (const [cellId, registers] of cells) {
    if (
      !registers.content ||
      !registers.position ||
      registers.visible?.value !== true
    ) {
      continue
    }
    const output = registers.outputs?.value ?? { outputs: [] }
    const stale = Boolean(
      output.sourceOperationId &&
        output.sourceOperationId !== registers.content.operationId
    )
    visibleCells.push({
      cell_id: cellId,
      ...registers.content.value,
      position: registers.position.value,
      source_operation_id: registers.content.operationId,
      outputs: output.outputs,
      output_execution_id: output.executionId,
      outputs_stale: stale,
    })
  }
  visibleCells.sort((left, right) => {
    const order = comparePositionIds(left.position, right.position)
    return order !== 0
      ? order
      : left.cell_id < right.cell_id
        ? -1
        : left.cell_id > right.cell_id
          ? 1
          : 0
  })

  const executions: MaterializedExecution[] = [...executionStarts].map(
    ([executionId, start]) => {
      const finish = executionFinishes.get(executionId)
      return {
        execution_id: executionId,
        start: start.payload,
        finish: finish?.payload,
        start_operation_id: start.operationId,
        finish_operation_id: finish?.operationId,
      }
    }
  )

  return {
    notebook: {
      frontmatter: notebookState?.value.frontmatter ?? {},
      metadata: notebookState?.value.metadata ?? {},
      cells: visibleCells,
    },
    comments,
    threadStatus: Object.fromEntries(
      [...threadStatus].map(([threadId, register]) => [
        threadId,
        register.value,
      ])
    ),
    executions,
    orderedOperationIds: ordered.ordered.map((operation) => operation.op_id),
    pendingOperationIds: ordered.pending.map((operation) => operation.op_id),
    unknownOperationIds,
  }
}
