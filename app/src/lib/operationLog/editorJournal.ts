import { clone, create, toJsonString } from '@bufbuild/protobuf'

import {
  RunmeExecutionState,
  RunmeMetadataKey,
  parser_pb,
} from '../../runme/client'
import { materializeOperationLog } from './materialize'
import { causalHeads, createRunmeOperation } from './mutations'
import { allocatePositionBetween } from './positions'
import type {
  JsonValue,
  NotebookUpdatePayload,
  OperationCell,
  PositionId,
  RunmeOperation,
} from './types'

const JSON_OPTIONS = { emitDefaultValues: true } as unknown as Parameters<
  typeof toJsonString
>[2]

export interface OperationLogDiffInput {
  previous: parser_pb.Notebook
  next: parser_pb.Notebook
  observedOperations: RunmeOperation[]
  actorId: string
  firstActorSequence: number
  createdAt?: () => string
}

function operationCell(cell: parser_pb.Cell): OperationCell {
  const protoCell = { ...cell, outputs: [] }
  const protoJson = JSON.parse(
    toJsonString(parser_pb.CellSchema, protoCell, JSON_OPTIONS)
  ) as Record<string, JsonValue>
  // Outputs have their own execution operations and must not be duplicated in
  // the content register. All other protobuf fields round-trip losslessly.
  delete protoJson.outputs
  return {
    kind:
      cell.kind === parser_pb.CellKind.MARKUP ? 'markup' : ('code' as const),
    language_id: cell.languageId,
    value: cell.value,
    metadata: { ...cell.metadata },
    proto_json: protoJson,
  }
}

function sameOperationCell(
  left: parser_pb.Cell,
  right: parser_pb.Cell
): boolean {
  return (
    JSON.stringify(operationCell(left)) === JSON.stringify(operationCell(right))
  )
}

function notebookUpdate(notebook: parser_pb.Notebook): NotebookUpdatePayload {
  return {
    metadata: { ...notebook.metadata },
    frontmatter: notebook.frontmatter
      ? (JSON.parse(
          toJsonString(
            parser_pb.FrontmatterSchema,
            notebook.frontmatter,
            JSON_OPTIONS
          )
        ) as Record<string, JsonValue>)
      : {},
  }
}

function protobufJson<T>(schema: Parameters<typeof toJsonString>[0], value: T) {
  return JSON.parse(
    toJsonString(schema as never, value as never, JSON_OPTIONS)
  ) as JsonValue
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

function outputJson(cell: parser_pb.Cell): JsonValue[] {
  return cell.outputs.map((output) => {
    const normalized = create(parser_pb.CellOutputSchema, {
      ...output,
      items: output.items.map((item) =>
        create(parser_pb.CellOutputItemSchema, {
          ...item,
          data:
            item.data instanceof Uint8Array
              ? item.data
              : new Uint8Array(
                  Object.values(item.data as unknown as Record<string, number>)
                ),
        })
      ),
    })
    return protobufJson(parser_pb.CellOutputSchema, normalized)
  })
}

/** Convert one debounced editor snapshot change into append-only operations. */
export async function buildOperationLogDiff({
  previous,
  next,
  observedOperations,
  actorId,
  firstActorSequence,
  createdAt = () => new Date().toISOString(),
}: OperationLogDiffInput): Promise<RunmeOperation[]> {
  const operations = [...observedOperations]
  const created: RunmeOperation[] = []
  let actorSequence = firstActorSequence
  let dependencies = causalHeads(observedOperations)
  const suggestionId = `${actorId}:suggestion:${firstActorSequence}`

  const append = (kind: string, payload: JsonValue) => {
    const operation = createRunmeOperation({
      actorId,
      actorSequence,
      dependencies,
      knownOperations: operations,
      kind,
      payload,
      suggestionId,
      createdAt: createdAt(),
    })
    actorSequence += 1
    dependencies = [operation.op_id]
    operations.push(operation)
    created.push(operation)
    return operation
  }

  const previousNotebookUpdate = notebookUpdate(previous)
  const nextNotebookUpdate = notebookUpdate(next)
  if (
    JSON.stringify(previousNotebookUpdate) !==
    JSON.stringify(nextNotebookUpdate)
  ) {
    append('notebook.update', nextNotebookUpdate as unknown as JsonValue)
  }

  const materialized = materializeOperationLog(observedOperations)
  const positions = new Map<string, PositionId>(
    materialized.notebook.cells.map((cell) => [cell.cell_id, cell.position])
  )
  const createdCellIds = new Set(
    observedOperations.flatMap((operation) => {
      if (operation.kind !== 'cell.create') return []
      const payload = operation.payload as unknown as { cell_id?: unknown }
      return typeof payload.cell_id === 'string' ? [payload.cell_id] : []
    })
  )
  const previousCells = new Map(
    previous.cells.map((cell) => [cell.refId, cell] as const)
  )
  const nextCells = new Map(
    next.cells.map((cell) => [cell.refId, cell] as const)
  )

  for (const previousCell of previous.cells) {
    if (!nextCells.has(previousCell.refId)) {
      append('cell.delete', { cell_id: previousCell.refId })
      positions.delete(previousCell.refId)
    }
  }

  let leftPosition: PositionId | null = null
  for (let index = 0; index < next.cells.length; index += 1) {
    const cell = next.cells[index]
    if (!cell.refId) {
      throw new Error('Operation-log cells require stable refId values')
    }
    let position = positions.get(cell.refId)
    if (!position) {
      let rightPosition: PositionId | null = null
      for (
        let rightIndex = index + 1;
        rightIndex < next.cells.length;
        rightIndex += 1
      ) {
        rightPosition = positions.get(next.cells[rightIndex].refId) ?? null
        if (rightPosition) break
      }
      position = allocatePositionBetween({
        left: leftPosition,
        right: rightPosition,
        actorId,
        actorSequence,
      })
      if (createdCellIds.has(cell.refId)) {
        // Reappearing stable IDs are tombstoned cells (for example Undo after
        // delete), not new identities. Restore visibility at the newly chosen
        // position and publish the editor's current content separately.
        append('cell.restore', {
          cell_id: cell.refId,
          position: position as unknown as JsonValue,
        })
        append('cell.update', {
          cell_id: cell.refId,
          cell: operationCell(cell) as unknown as JsonValue,
        })
      } else {
        append('cell.create', {
          cell_id: cell.refId,
          position: position as unknown as JsonValue,
          cell: operationCell(cell) as unknown as JsonValue,
        })
        createdCellIds.add(cell.refId)
      }
      positions.set(cell.refId, position)
    } else {
      const previousCell = previousCells.get(cell.refId)
      if (previousCell && !sameOperationCell(previousCell, cell)) {
        append('cell.update', {
          cell_id: cell.refId,
          cell: operationCell(cell) as unknown as JsonValue,
        })
      }
    }
    leftPosition = position
  }

  const currentOrder = materialized.notebook.cells
    .map((cell) => cell.cell_id)
    .filter((cellId) => nextCells.has(cellId))
  for (const cell of next.cells) {
    if (!currentOrder.includes(cell.refId)) currentOrder.push(cell.refId)
  }
  const targetOrder = next.cells.map((cell) => cell.refId)
  for (let index = 0; index < targetOrder.length; index += 1) {
    const cellId = targetOrder[index]
    const currentIndex = currentOrder.indexOf(cellId)
    if (currentIndex === index) continue
    currentOrder.splice(currentIndex, 1)
    currentOrder.splice(index, 0, cellId)
    const left =
      index > 0 ? (positions.get(currentOrder[index - 1]) ?? null) : null
    const right =
      index + 1 < currentOrder.length
        ? (positions.get(currentOrder[index + 1]) ?? null)
        : null
    const position = allocatePositionBetween({
      left,
      right,
      actorId,
      actorSequence,
    })
    append('cell.move', {
      cell_id: cellId,
      position: position as unknown as JsonValue,
    })
    positions.set(cellId, position)
  }

  for (const cell of next.cells) {
    const previousCell = previousCells.get(cell.refId)
    const previousRunId = previousCell?.metadata?.[RunmeMetadataKey.LastRunID]
    const persistedRunId = cell.metadata?.[RunmeMetadataKey.LastRunID]
    const previousOutputs = previousCell ? outputJson(previousCell) : []
    const nextOutputs = outputJson(cell)
    const nextRunId =
      persistedRunId ??
      (!previousCell && nextOutputs.length > 0
        ? `${actorId}:imported-execution:${actorSequence}`
        : undefined)
    const outputsChanged =
      JSON.stringify(previousOutputs) !== JSON.stringify(nextOutputs)
    if (
      previousCell &&
      !nextRunId &&
      previousOutputs.length > 0 &&
      nextOutputs.length === 0
    ) {
      append('cell.clear_outputs', {
        cell_id: cell.refId,
        reason: 'editor-cleared',
      })
      continue
    }

    const runChanged = Boolean(nextRunId && nextRunId !== previousRunId)
    if (runChanged) {
      const source = materializeOperationLog(operations).notebook.cells.find(
        (candidate) => candidate.cell_id === cell.refId
      )
      const startedAt = createdAt()
      append('execution.start', {
        execution_id: nextRunId!,
        cell_id: cell.refId,
        source_op_id: source?.source_operation_id ?? dependencies[0] ?? '',
        input: {
          language_id: cell.languageId,
          value: cell.value,
          execution_metadata: { ...cell.metadata },
        },
        input_sha256: await sha256(`${cell.languageId}\u0000${cell.value}`),
        runner: {
          runner_id:
            cell.metadata?.[RunmeMetadataKey.RunnerName] ?? 'runme-default',
          runtime:
            (cell.metadata?.[RunmeMetadataKey.JupyterKernelName] ??
              cell.languageId) ||
            'unknown',
          runtime_version: 'unknown',
          environment_digest: null,
        },
        started_at: startedAt,
      })
    }

    const previousState =
      previousCell?.metadata?.[RunmeMetadataKey.ExecutionState]
    const nextState = cell.metadata?.[RunmeMetadataKey.ExecutionState]
    const completed =
      nextState === RunmeExecutionState.Completed ||
      nextState === RunmeExecutionState.Unknown ||
      (!previousCell && nextOutputs.length > 0)
    if (
      nextRunId &&
      completed &&
      (runChanged || previousState !== nextState || outputsChanged)
    ) {
      const exitCode = Number(cell.metadata?.[RunmeMetadataKey.ExitCode] ?? 0)
      append('execution.finish', {
        execution_id: nextRunId,
        status:
          nextState === RunmeExecutionState.Unknown
            ? 'lost'
            : exitCode === 0
              ? 'succeeded'
              : 'failed',
        outputs: nextOutputs,
        execution_summary: cell.executionSummary
          ? (protobufJson(
              parser_pb.CellExecutionSummarySchema,
              cell.executionSummary
            ) as Record<string, JsonValue>)
          : {},
        finished_at: createdAt(),
      })
    }
  }

  return created
}

export function cloneNotebook(
  notebook: parser_pb.Notebook
): parser_pb.Notebook {
  return clone(parser_pb.NotebookSchema, notebook)
}
