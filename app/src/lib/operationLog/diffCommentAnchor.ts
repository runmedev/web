import type { CellDiff } from '../notebookDiff/model'

/** Offsets are UTF-16 code units in the frozen cell source, matching DOM Ranges. */
export type DiffCommentTarget = {
  cellId: string
  side: 'base' | 'head'
  quote: string
  sourceRange?: { start: number; end: number; unit: 'utf-16' }
}

/** Resolve only against the comparison snapshots, never the live editor. */
export function createDiffCommentTarget(
  rows: CellDiff[],
  cellId: string,
  side?: 'base' | 'head',
  sourceRange?: DiffCommentTarget['sourceRange']
): DiffCommentTarget {
  const row = rows.find((r) => (r.compareCell ?? r.baseCell)?.refId === cellId)
  const resolvedSide = side ?? (row?.compareCell ? 'head' : 'base')
  if (!['base', 'head'].includes(resolvedSide))
    throw new Error('Invalid diff side')
  const cell = resolvedSide === 'base' ? row?.baseCell : row?.compareCell
  if (!cell) throw new Error('Cell not found on this side of the comparison')
  if (
    sourceRange &&
    (sourceRange.unit !== 'utf-16' ||
      !Number.isSafeInteger(sourceRange.start) ||
      !Number.isSafeInteger(sourceRange.end) ||
      sourceRange.start < 0 ||
      sourceRange.end <= sourceRange.start ||
      sourceRange.end > cell.value.length)
  )
    throw new Error('Invalid diff source range')
  return {
    cellId,
    side: resolvedSide,
    quote: sourceRange
      ? cell.value.slice(sourceRange.start, sourceRange.end)
      : cell.value,
    ...(sourceRange ? { sourceRange: { ...sourceRange } } : {}),
  }
}

/** Optional extension shared by review and suggestion anchors; legacy anchors remain valid. */
export function parseDiffCommentTarget(
  anchor?: string
): DiffCommentTarget | undefined {
  try {
    const target = JSON.parse(anchor ?? '').runme?.diffTarget
    if (
      !target ||
      typeof target.cellId !== 'string' ||
      typeof target.quote !== 'string' ||
      !['base', 'head'].includes(target.side)
    )
      return undefined
    const range = target.sourceRange
    if (
      range &&
      (range.unit !== 'utf-16' ||
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < 0 ||
        range.end <= range.start)
    )
      return undefined
    return target
  } catch {
    return undefined
  }
}
