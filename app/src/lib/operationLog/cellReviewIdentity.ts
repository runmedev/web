import type { NotebookDiff } from '../notebookDiff/model'
import { canonicalJson } from './canonicalJson'
import { materializeOperationLog } from './materialize'
import type { JsonValue, RunmeOperation } from './types'

export function cellStateKey(value: unknown): string {
  // Optional materialized fields may be undefined; canonical JSON omits them.
  return canonicalJson(JSON.parse(JSON.stringify(value ?? null)) as JsonValue)
}

/** Cell-local registers preserve acceptance across unrelated edits, but not
 * across a new edit that happens to reproduce identical text or a different move.
 */
export function withCellReviewKeys(
  diff: NotebookDiff,
  operations: RunmeOperation[],
  baseIds: string[],
  headIds: string[]
): NotebookDiff {
  const cellsAt = (ids: string[]) => {
    const included = new Set(ids)
    return new Map(
      materializeOperationLog(
        operations.filter((op) => included.has(op.op_id))
      ).notebook.cells.map((cell) => [cell.cell_id, cell])
    )
  }
  const base = cellsAt(baseIds)
  const head = cellsAt(headIds)
  const history = (ids: string[], cellId: string) => {
    const included = new Set(ids)
    return operations
      .filter(
        (op) =>
          included.has(op.op_id) &&
          op.kind.startsWith('cell.') &&
          (op.payload as any).cell_id === cellId
      )
      .map((op) => op.op_id)
      .sort()
  }
  return {
    ...diff,
    cells: diff.cells.map((row) => {
      const id = (row.compareCell ?? row.baseCell)!.refId
      const neighbors = (cells: Map<string, unknown>) => {
        const ids = [...cells.keys()]
        const index = ids.indexOf(id)
        return [ids[index - 1] ?? null, ids[index + 1] ?? null]
      }
      return {
        ...row,
        reviewKey: cellStateKey([
          base.get(id) ?? null,
          head.get(id) ?? null,
          history(baseIds, id),
          history(headIds, id),
          ...(row.moved ? [neighbors(base), neighbors(head)] : []),
        ]),
      }
    }),
  }
}
