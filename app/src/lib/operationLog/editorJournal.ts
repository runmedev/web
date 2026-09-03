import { clone, toJsonString } from '@bufbuild/protobuf'

import { parser_pb } from '../../runme/client'
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
  return {
    kind:
      cell.kind === parser_pb.CellKind.MARKUP ? 'markup' : ('code' as const),
    language_id: cell.languageId,
    value: cell.value,
    metadata: { ...cell.metadata },
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

/** Convert one debounced editor snapshot change into append-only operations. */
export function buildOperationLogDiff({
  previous,
  next,
  observedOperations,
  actorId,
  firstActorSequence,
  createdAt = () => new Date().toISOString(),
}: OperationLogDiffInput): RunmeOperation[] {
  const operations = [...observedOperations]
  const created: RunmeOperation[] = []
  let actorSequence = firstActorSequence
  let dependencies = causalHeads(observedOperations)

  const append = (kind: string, payload: JsonValue) => {
    const operation = createRunmeOperation({
      actorId,
      actorSequence,
      dependencies,
      knownOperations: operations,
      kind,
      payload,
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
      append('cell.create', {
        cell_id: cell.refId,
        position: position as unknown as JsonValue,
        cell: operationCell(cell) as unknown as JsonValue,
      })
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

  return created
}

export function cloneNotebook(
  notebook: parser_pb.Notebook
): parser_pb.Notebook {
  return clone(parser_pb.NotebookSchema, notebook)
}
