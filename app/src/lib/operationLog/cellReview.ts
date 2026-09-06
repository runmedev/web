import { toJson } from '@bufbuild/protobuf'

import { parser_pb } from '../../runme/client'
import type { CellDiff } from '../notebookDiff/model'
import { canonicalJson } from './canonicalJson'
import type { NotebookReviewRound } from './reviews'
import type { JsonValue } from './types'

/** Full cell snapshots, not document revision IDs: unrelated document edits do
 * not invalidate acceptance. Outputs and metadata are part of the reviewed cell.
 * Absolute indexes are deliberately excluded (inserting a neighbor shifts them).
 */
export function cellChangeKey(row: CellDiff): string {
  if (row.reviewKey) return row.reviewKey
  return canonicalJson([
    row.baseCell ? toJson(parser_pb.CellSchema, row.baseCell) : null,
    row.compareCell ? toJson(parser_pb.CellSchema, row.compareCell) : null,
    row.moved,
  ] as JsonValue)
}

/** Journal order, never wall-clock timestamps, resolves decisions across pairs. */
export function cellDecisionFor(row: CellDiff, rounds: NotebookReviewRound[]) {
  const id = (row.compareCell ?? row.baseCell)?.refId
  const key = cellChangeKey(row)
  return rounds
    .flatMap((round) => {
      const reviewed = round.diff.cells.find(
        (r) => (r.compareCell ?? r.baseCell)?.refId === id
      )
      return reviewed && cellChangeKey(reviewed) === key
        ? (round.cellDecisions ?? []).filter((d) => d.cellId === id)
        : []
    })
    .sort((a, b) => b.order - a.order)[0]
}

/** Accepted changes render as ordinary proposed cells; accepted deletions have
 * no source body. Discussions remain accessible in the gutter in either case.
 */
export function acceptedCell(row: CellDiff): CellDiff | undefined {
  if (!row.compareCell) return undefined
  return {
    ...row,
    kind: 'unchanged',
    baseCell: row.compareCell,
    moved: false,
    changedFields: [],
    sourceDiff: undefined,
    metadataDiff: undefined,
    outputDiff: undefined,
  }
}
