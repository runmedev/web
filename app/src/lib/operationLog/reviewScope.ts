import type { parser_pb } from '../../runme/client'
import { computeNotebookDiff, summarize } from '../notebookDiff/diff'
import { extractNotebookOutline } from '../notebookOutline'

/** Omitted scope means the whole document. Explicit scopes are nonempty sets
 * of durable cell IDs present in either frozen endpoint, not index ranges.
 */
export function normalizeReviewCellIds(
  value: unknown,
  before: parser_pb.Notebook,
  after: parser_pb.Notebook
): string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((id) => typeof id !== 'string' || !id.trim())
  )
    throw new Error('Review cellIds must be a nonempty array of cell IDs')
  const available = new Set(
    [...before.cells, ...after.cells].map((c) => c.refId)
  )
  if (value.some((id) => !available.has(id)))
    throw new Error('Review cell IDs must exist in the start or end revision')
  return [...new Set(value as string[])].sort()
}

/** Keep the old whole-document identity; scoped identities add a canonical set. */
export function reviewIdentityKey(
  start: string,
  end: string,
  cellIds?: string[]
): string {
  return JSON.stringify(
    cellIds === undefined
      ? [start, end]
      : [start, end, [...new Set(cellIds)].sort()]
  )
}

/** Diff full endpoints first so move detection and source indexes stay intact.
 * Then restrict rows and counts to the scope; never match different cell IDs
 * merely because their contents happen to be identical.
 */
export function computeReviewDiff(
  before: parser_pb.Notebook,
  after: parser_pb.Notebook,
  cellIds?: string[]
) {
  const diff = computeNotebookDiff(before, after, {
    includeMetadata: true,
    includeOutputs: true,
    matchCellIdsOnly: true,
  })
  if (cellIds === undefined) return diff
  const included = new Set(cellIds)
  const cells = diff.cells.filter(
    (row) =>
      included.has(row.baseCell?.refId ?? '') ||
      included.has(row.compareCell?.refId ?? '')
  )
  return { ...diff, cells, summary: summarize(cells) }
}

/** Heading ranges are a UI convenience only. A section includes its heading,
 * descendant headings and body through the next heading of equal/lower depth.
 * Multiple headings in one cell round outward to whole-cell boundaries.
 */
export function reviewOutlineSections(notebook: parser_pb.Notebook) {
  const headings = extractNotebookOutline(notebook.cells)
  const indices = new Map(notebook.cells.map((cell, i) => [cell.refId, i]))
  return headings.map((heading, i) => {
    const startIndex = indices.get(heading.cellRefId)!
    const next = headings.slice(i + 1).find((h) => h.level <= heading.level)
    const endIndex = next
      ? Math.max(startIndex, indices.get(next.cellRefId)! - 1)
      : notebook.cells.length - 1
    return {
      ...heading,
      key: `${heading.cellRefId}:${heading.line}`,
      startIndex,
      endIndex,
    }
  })
}

/** Resolve inclusive section endpoints to arbitrary reusable IDs, never persist
 * the outline or cell indexes as the review scope.
 */
export function reviewSectionCellIds(
  notebook: parser_pb.Notebook,
  from: string,
  through: string
): string[] {
  const sections = reviewOutlineSections(notebook)
  const start = sections.find((s) => s.key === from)
  const end = sections.find((s) => s.key === through)
  if (!start || !end || sections.indexOf(end) < sections.indexOf(start))
    throw new Error('Choose an end section at or after the start section')
  return notebook.cells
    .slice(start.startIndex, end.endIndex + 1)
    .map((cell) => cell.refId)
}
