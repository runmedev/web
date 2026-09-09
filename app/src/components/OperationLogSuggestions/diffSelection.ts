import type { CellDiff } from '../../lib/notebookDiff/model'
import {
  type DiffCommentTarget,
  createDiffCommentTarget,
} from '../../lib/operationLog/diffCommentAnchor'

/** Map selected diff runs to one contiguous range on a single frozen side.
 * Mixed removed/added text is not a source range, so it fails closed.
 */
export function captureDiffSelection(
  root: HTMLElement,
  row: CellDiff
): DiffCommentTarget | undefined {
  const selection = root.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return undefined
  const range = selection.getRangeAt(0)
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    throw new Error('Select text within a single diff cell.')
  const pieces: { value: string; base?: number; head?: number }[] = []
  for (const span of root.querySelectorAll<HTMLElement>('[data-diff-run]')) {
    if (!range.intersectsNode(span)) continue
    const part = root.ownerDocument.createRange()
    part.selectNodeContents(span)
    if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0)
      part.setStart(range.startContainer, range.startOffset)
    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0)
      part.setEnd(range.endContainer, range.endOffset)
    const value = part.toString()
    if (!value) continue
    const prefix = root.ownerDocument.createRange()
    prefix.selectNodeContents(span)
    prefix.setEnd(part.startContainer, part.startOffset)
    const offset = prefix.toString().length
    pieces.push({
      value,
      base:
        span.dataset.baseOffset === undefined
          ? undefined
          : Number(span.dataset.baseOffset) + offset,
      head:
        span.dataset.headOffset === undefined
          ? undefined
          : Number(span.dataset.headOffset) + offset,
    })
  }
  if (!pieces.length) return undefined
  const side = pieces.every((p) => p.head !== undefined)
    ? 'head'
    : pieces.every((p) => p.base !== undefined)
      ? 'base'
      : undefined
  if (!side)
    throw new Error(
      'Select either removed text or added text, not both. You can comment on the whole cell instead.'
    )
  const start = pieces[0][side]!
  let end = start
  for (const piece of pieces) {
    if (piece[side] !== end)
      throw new Error('Select a contiguous range on one side of the diff.')
    end += piece.value.length
  }
  const target = createDiffCommentTarget(
    [row],
    (row.compareCell ?? row.baseCell)!.refId,
    side,
    { start, end, unit: 'utf-16' }
  )
  if (
    target.quote !== pieces.map((p) => p.value).join('') ||
    target.quote !== range.toString()
  )
    throw new Error('The selection includes content outside the cell source.')
  return target
}
