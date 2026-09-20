import { parser_pb } from '../runme/client'
import type { previewComparison } from './operationLog/comparisons'
import type { ExampleCell, ExampleEdit } from './trainingExamples/model'
import { planContentExample } from './trainingExamples/payloads'

/** Grade exactly this cell's transition with baseline notebook context. Unrelated
 * head edits cannot leak into the proposal; inserts/moves use a surviving predecessor.
 */
export function prepareSuggestionInput(
  preview: ReturnType<typeof previewComparison>,
  cellId: string
) {
  const row = preview.diff.cells.find(
    (r) => (r.compareCell ?? r.baseCell)?.refId === cellId
  )
  if (!row) throw new Error('Cell is outside the selected comparison')
  const content = (c: parser_pb.Cell) => ({
    kind:
      c.kind === parser_pb.CellKind.MARKUP
        ? ('markup' as const)
        : ('code' as const),
    language: c.languageId,
    value: c.value,
  })
  const initial: ExampleCell[] = preview.before.cells.map((c) => ({
    cell: c.refId,
    ...content(c),
  }))
  const previous = row.baseCell,
    next = row.compareCell
  const operations: ExampleEdit[] = []
  const at = preview.after.cells.findIndex((c) => c.refId === cellId)
  const predecessor =
    preview.after.cells
      .slice(0, at)
      .reverse()
      .find(
        (c) => c.refId !== cellId && initial.some((b) => b.cell === c.refId)
      )?.refId ?? null
  if (previous && !next) operations.push({ kind: 'delete', cell: cellId })
  if (!previous && next)
    operations.push({
      kind: 'insert',
      cell: cellId,
      after: predecessor,
      content: content(next),
    })
  if (previous && next) {
    // The view marks index shifts as moves, including shifts caused only by
    // another cell's insertion/deletion. Compare surviving neighbors so those
    // changes do not become spurious proposals (or billable predictions).
    const survivingIds = new Set(preview.after.cells.map((c) => c.refId))
    const previousPredecessor = initial
      .slice(0, initial.findIndex((c) => c.cell === cellId))
      .reverse()
      .find((c) => survivingIds.has(c.cell))?.cell ?? null
    if (row.moved && previousPredecessor !== predecessor)
      operations.push({ kind: 'move', cell: cellId, after: predecessor })
    if (JSON.stringify(content(previous)) !== JSON.stringify(content(next)))
      operations.push({ kind: 'update', cell: cellId, content: content(next) })
  }
  return planContentExample({ initial, operations })
}
