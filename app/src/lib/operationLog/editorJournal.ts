import { clone, create, toJsonString } from '@bufbuild/protobuf'

import {
  RunmeExecutionState,
  RunmeMetadataKey,
  parser_pb,
} from '../../runme/client'
import { CELL_PAGE, PAGE_PREFIX } from '../notebookPages'
import { isRecoveredOutput } from '../recoveredOutputs'
import type { EditorFrontier } from './editorFrontier'
import { materializeOperationLog } from './materialize'
import {
  causalHeads,
  createRunmeOperation,
  operationAtFrontier,
} from './mutations'
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
  frontier?: EditorFrontier
  actorId: string
  firstActorSequence: number
  createdAt?: () => string
}

function operationCell(cell: parser_pb.Cell): OperationCell {
  const metadata = { ...cell.metadata }
  delete metadata[CELL_PAGE]
  const protoCell = { ...cell, metadata, outputs: [] }
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
    metadata,
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
    metadata: Object.fromEntries(
      Object.entries(notebook.metadata).filter(
        ([key]) => !key.startsWith(PAGE_PREFIX)
      )
    ),
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
  // Recovery diagnostics belong to the display, never to execution history.
  return cell.outputs
    .filter((output) => !isRecoveredOutput(output))
    .map((output) => {
      const normalized = create(parser_pb.CellOutputSchema, {
        ...output,
        items: output.items.map((item) =>
          create(parser_pb.CellOutputItemSchema, {
            ...item,
            data:
              item.data instanceof Uint8Array
                ? item.data
                : new Uint8Array(
                    Object.values(
                      item.data as unknown as Record<string, number>
                    )
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
  frontier,
  actorId,
  firstActorSequence,
  createdAt = () => new Date().toISOString(),
}: OperationLogDiffInput): Promise<RunmeOperation[]> {
  const operations = [...observedOperations]
  const created: RunmeOperation[] = []
  let actorSequence = firstActorSequence
  let dependencies = frontier?.heads ?? causalHeads(observedOperations)
  let clock = frontier?.lamport ?? 0
  const sourceWrites = new Map<string, string>()
  const suggestionId = `${actorId}:suggestion:${firstActorSequence}`

  const append = (kind: string, payload: JsonValue) => {
    const fields = {
      actorId,
      actorSequence,
      dependencies,
      kind,
      payload,
      suggestionId,
      createdAt: createdAt(),
    }
    const operation = frontier
      ? operationAtFrontier(fields, ++clock)
      : createRunmeOperation({ ...fields, knownOperations: operations })
    if (kind === 'cell.create' || kind === 'cell.update')
      sourceWrites.set(
        (payload as { cell_id: string }).cell_id,
        operation.op_id
      )
    actorSequence += 1
    dependencies = [operation.op_id]
    operations.push(operation)
    created.push(operation)
    return operation
  }

  // Each page property has an independent register, so a stale editor can
  // rename a page concurrently with another editor changing its position.
  for (const key of new Set([
    ...Object.keys(previous.metadata),
    ...Object.keys(next.metadata),
  ])) {
    if (
      key.startsWith(PAGE_PREFIX) &&
      previous.metadata[key] !== next.metadata[key]
    ) {
      append('page.set', { key, value: next.metadata[key] ?? null })
    }
  }
  const previousNotebookUpdate = notebookUpdate(previous)
  const nextNotebookUpdate = notebookUpdate(next)
  if (
    JSON.stringify(previousNotebookUpdate) !==
    JSON.stringify(nextNotebookUpdate)
  ) {
    append('notebook.update', nextNotebookUpdate as unknown as JsonValue)
  }

  const materialized = frontier
    ? undefined
    : materializeOperationLog(observedOperations)
  const positions = new Map<string, PositionId>(
    frontier
      ? [...frontier.cells].map(([id, c]) => [id, c.position] as const)
      : materialized!.notebook.cells.map((cell) => [
          cell.cell_id,
          cell.position,
        ])
  )
  const createdCellIds = new Set(
    frontier?.createdIds ??
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
    const previousPage = previousCells.get(cell.refId)?.metadata[CELL_PAGE]
    if (previousPage !== cell.metadata[CELL_PAGE]) {
      append('cell.set_page', {
        cell_id: cell.refId,
        page_id: cell.metadata[CELL_PAGE] ?? null,
      })
    }
    leftPosition = position
  }

  const currentOrder = [...positions.keys()].filter((cellId) =>
    nextCells.has(cellId)
  )
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
    // A failed setup attempt has output but no backend run ID. Give a
    // replacement for recovered output a durable execution identity so reopening
    // cannot restore the old diagnostic. Unchanged snapshots emit no new run.
    const replacedRecovery = Boolean(
      previousCell?.outputs.some(isRecoveredOutput) &&
        !cell.outputs.some(isRecoveredOutput) &&
        nextOutputs.length > 0
    )
    const nextRunId =
      persistedRunId ??
      ((!previousCell || replacedRecovery) && nextOutputs.length > 0
        ? `${actorId}:imported-execution:${actorSequence}`
        : undefined)
    const outputsChanged =
      JSON.stringify(previousOutputs) !== JSON.stringify(nextOutputs)
    if (
      previousCell &&
      !nextRunId &&
      // A user clear also removes recovery-only output. Compare the visible
      // snapshots here, before filtering diagnostics out of saved results.
      previousCell.outputs.length > 0 &&
      cell.outputs.length === 0
    ) {
      append('cell.clear_outputs', {
        cell_id: cell.refId,
        reason: 'editor-cleared',
      })
      continue
    }

    const runChanged = Boolean(nextRunId && nextRunId !== previousRunId)
    // Metadata can return to a historical run after a stale snapshot, restore,
    // or refresh. That is not a second execution start. Use effective history so
    // a rejected start does not prevent a subsequent accepted execution.
    const knownStart = frontier
      ? Boolean(nextRunId && frontier.starts.get(nextRunId) === cell.refId)
      : materialized!.executions.some(
          (execution) =>
            execution.execution_id === nextRunId &&
            execution.start.cell_id === cell.refId
        )
    if (runChanged && !knownStart) {
      const sourceId = frontier
        ? (sourceWrites.get(cell.refId) ??
          frontier.cells.get(cell.refId)?.source)
        : materializeOperationLog(operations).notebook.cells.find(
            (candidate) => candidate.cell_id === cell.refId
          )?.source_operation_id
      const startedAt = createdAt()
      append('execution.start', {
        execution_id: nextRunId!,
        cell_id: cell.refId,
        source_op_id: sourceId ?? dependencies[0] ?? '',
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
