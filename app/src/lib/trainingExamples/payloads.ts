import {
  allocatePositionBetween,
  comparePositionIds,
  validatePositionId,
} from '../operationLog/positions'
import type { VersionRef } from '../operationLog/records'
import type {
  CellCreatePayload,
  CellIdentityPayload,
  CellMovePayload,
  CellUpdatePayload,
  OperationCell,
  RunmeOperation,
} from '../operationLog/types'
import {
  type ClassifierInput,
  type ExampleCell,
  applyExampleEdits,
  exampleJson,
  prepareExample,
} from './model'

/** Reuse the notebook operation payloads, without causal/author envelopes. */
export type ContentOperation =
  | { kind: 'cell.create'; payload: CellCreatePayload }
  | { kind: 'cell.update'; payload: CellUpdatePayload }
  | { kind: 'cell.delete'; payload: CellIdentityPayload }
  | { kind: 'cell.move'; payload: CellMovePayload }
export interface PreparedExample {
  initial: CellCreatePayload[]
  operations: ContentOperation[]
}

/** A whitelist deliberately drops outputs, metadata and lossless proto fields. */
function content(cell: OperationCell): OperationCell {
  if (
    !cell ||
    !['code', 'markup'].includes(cell.kind) ||
    typeof cell.language_id !== 'string' ||
    typeof cell.value !== 'string'
  )
    throw new Error('Invalid cell content')
  return {
    kind: cell.kind,
    language_id: cell.language_id,
    value: cell.value,
    metadata: {},
  }
}

/** Strict isolated replay of existing content payloads. Never writes CRDT records. */
export function replayContent(
  initial: CellCreatePayload[],
  operations: ContentOperation[]
): CellCreatePayload[] {
  const result = new Map<string, CellCreatePayload>()
  for (const cell of initial) {
    if (typeof cell.cell_id !== 'string' || !cell.cell_id)
      throw new Error('Invalid cell identity')
    if (result.has(cell.cell_id)) throw new Error('Duplicate cell identity')
    validatePositionId(cell.position)
    result.set(cell.cell_id, {
      cell_id: cell.cell_id,
      cell: content(cell.cell),
      position: cell.position,
    })
  }
  for (const operation of operations) {
    const { payload } = operation
    if (!payload || typeof payload.cell_id !== 'string' || !payload.cell_id)
      throw new Error('Invalid cell identity')
    const existing = result.get(payload.cell_id)
    if (operation.kind === 'cell.create') {
      if (existing) throw new Error('Duplicate create target')
      validatePositionId(operation.payload.position)
      result.set(payload.cell_id, {
        ...operation.payload,
        cell: content(operation.payload.cell),
      })
    } else {
      if (!existing) throw new Error('Missing content operation target')
      if (operation.kind === 'cell.delete') result.delete(payload.cell_id)
      else if (operation.kind === 'cell.update')
        result.set(payload.cell_id, {
          ...existing,
          cell: content(operation.payload.cell),
        })
      else if (operation.kind === 'cell.move') {
        validatePositionId(operation.payload.position)
        result.set(payload.cell_id, {
          ...existing,
          position: operation.payload.position,
        })
      } else throw new Error('Unsupported content operation')
    }
  }
  const ordered = [...result.values()].sort((a, b) =>
    comparePositionIds(a.position, b.position)
  )
  if (
    ordered.some(
      (cell, i) =>
        i > 0 &&
        comparePositionIds(ordered[i - 1].position, cell.position) === 0
    )
  ) {
    throw new Error('Duplicate content position')
  }
  return ordered
}

/** Sanitize recipe-provided native payloads as well as extracted examples.
 * A single order-preserving position map removes actor IDs without changing
 * which cell a move targets. Never trust callers to strip metadata themselves.
 */
export function normalizePreparedExample(
  input: PreparedExample
): PreparedExample {
  replayContent(input.initial, input.operations)
  const ids = new Map<string, string>()
  const positions = [...input.initial.map((cell) => cell.position)]
  for (const cell of input.initial)
    ids.set(cell.cell_id, `cell-${ids.size + 1}`)
  for (const op of input.operations) {
    if (!ids.has(op.payload.cell_id))
      ids.set(op.payload.cell_id, `cell-${ids.size + 1}`)
    if (op.kind === 'cell.create' || op.kind === 'cell.move')
      positions.push(op.payload.position)
  }
  positions.sort(comparePositionIds)
  const ranks = new Map<string, number>()
  for (const position of positions) {
    const key = exampleJson(position)
    if (!ranks.has(key)) ranks.set(key, ranks.size)
  }
  const position = (
    value: CellCreatePayload['position']
  ): CellCreatePayload['position'] => [
    [ranks.get(exampleJson(value))! * 1024, 'content', 1],
  ]
  return {
    initial: input.initial.map((cell) => ({
      cell_id: ids.get(cell.cell_id)!,
      position: position(cell.position),
      cell: content(cell.cell),
    })),
    operations: input.operations.map((op): ContentOperation => {
      const cell_id = ids.get(op.payload.cell_id)!
      switch (op.kind) {
        case 'cell.create':
          return {
            kind: op.kind,
            payload: {
              cell_id,
              position: position(op.payload.position),
              cell: content(op.payload.cell),
            },
          }
        case 'cell.update':
          return {
            kind: op.kind,
            payload: { cell_id, cell: content(op.payload.cell) },
          }
        case 'cell.move':
          return {
            kind: op.kind,
            payload: { cell_id, position: position(op.payload.position) },
          }
        case 'cell.delete':
          return { kind: op.kind, payload: { cell_id } }
      }
    }),
  }
}

/** Normalize identities and positions into a training-only namespace, then
 * translate the net-edit plan to native payloads and verify its replay.
 */
export function prepareContentExample(
  operations: RunmeOperation[],
  example: { start: VersionRef; end: VersionRef }
): PreparedExample {
  return planContentExample(prepareExample(operations, example))
}

/** Convert a normalized, possibly scoped plan to native content payloads. */
export function planContentExample(planned: ClassifierInput): PreparedExample {
  const toContent = (
    cell: Pick<ExampleCell, 'kind' | 'language' | 'value'>
  ): OperationCell => ({
    kind: cell.kind,
    language_id: cell.language,
    value: cell.value,
    metadata: {},
  })
  const initial: CellCreatePayload[] = planned.initial.map((cell, i) => ({
    cell_id: cell.cell,
    cell: toContent(cell),
    position: [[i * 1024, 'content', i + 1]],
  }))
  let current = initial
  const result: ContentOperation[] = []
  for (const edit of planned.operations) {
    let op: ContentOperation
    if (edit.kind === 'delete')
      op = { kind: 'cell.delete', payload: { cell_id: edit.cell } }
    else if (edit.kind === 'update')
      op = {
        kind: 'cell.update',
        payload: { cell_id: edit.cell, cell: toContent(edit.content) },
      }
    else {
      const remaining = current.filter((cell) => cell.cell_id !== edit.cell)
      const at =
        edit.after === null
          ? -1
          : remaining.findIndex((cell) => cell.cell_id === edit.after)
      if (edit.after !== null && at < 0)
        throw new Error('Missing position anchor')
      const position = allocatePositionBetween({
        left: remaining[at]?.position ?? null,
        right: remaining[at + 1]?.position ?? null,
        actorId: 'content',
        actorSequence: result.length + 1,
      })
      op =
        edit.kind === 'insert'
          ? {
              kind: 'cell.create',
              payload: {
                cell_id: edit.cell,
                position,
                cell: toContent(edit.content),
              },
            }
          : { kind: 'cell.move', payload: { cell_id: edit.cell, position } }
    }
    result.push(op)
    current = replayContent(current, [op])
  }
  const actual = replayContent(initial, result).map((c) => ({
    cell: c.cell_id,
    kind: c.cell.kind,
    language: c.cell.language_id,
    value: c.cell.value,
  }))
  if (
    exampleJson(actual) !==
    exampleJson(applyExampleEdits(planned.initial, planned.operations))
  )
    throw new Error('Content replay mismatch')
  return { initial, operations: result }
}
