import type { DriveComment } from '../storage/drive'
import type { Anchor } from './operationLog/records'

export type SourceLocation =
  | { status: 'exact' | 'mapped' | 'fuzzy'; start: number; end: number }
  | { status: 'cell' | 'outdated' | 'deleted' | 'unavailable' }
export type HistoricalAnchor = { anchor: Anchor; source?: string }
export type LocatedAnchor = HistoricalAnchor & {
  location: SourceLocation
  side?: 'base' | 'head'
}

// Deliberately conservative, deterministic budgets. Exhaustion never produces a
// best-effort highlight. Cache only a few source pairs, never notebook history.
export const ANCHOR_MAPPING_LIMITS = Object.freeze({
  sourceLength: 20_000,
  matrixCells: 500_000,
  searchRadius: 48,
  distance: 3,
  fuzzyWork: 250_000,
  shortSelection: 8,
  margin: 2,
})
type EditMap = {
  a: string[]
  b: string[]
  positions: number[]
  preserved: boolean[]
}
const maps = new Map<string, EditMap | null>()

/** Compute one code-point edit mapping per source pair, shared by all anchors. */
function editMap(before: string, after: string): EditMap | null {
  const key = JSON.stringify([before, after])
  if (maps.has(key)) return maps.get(key)!
  const a = Array.from(before),
    b = Array.from(after)
  if (
    a.length > ANCHOR_MAPPING_LIMITS.sourceLength ||
    b.length > ANCHOR_MAPPING_LIMITS.sourceLength
  )
    return null
  let prefix = 0,
    suffix = 0
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix])
    prefix++
  while (
    suffix < Math.min(a.length, b.length) - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++
  const n = a.length - prefix - suffix,
    m = b.length - prefix - suffix
  let result: EditMap | null = null
  if ((n + 1) * (m + 1) <= ANCHOR_MAPPING_LIMITS.matrixCells) {
    const width = m + 1,
      dp = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * width + j] =
          a[prefix + i] === b[prefix + j]
            ? 1 + dp[(i + 1) * width + j + 1]!
            : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!)
    const positions = Array<number>(a.length + 1).fill(-1),
      preserved = Array<boolean>(a.length).fill(false)
    for (let k = 0; k < prefix; k++) {
      positions[k] = k
      preserved[k] = true
    }
    let i = 0,
      j = 0
    while (i < n || j < m) {
      positions[prefix + i] = prefix + j
      if (i < n && j < m && a[prefix + i] === b[prefix + j]) {
        preserved[prefix + i] = true
        i++
        j++
      } else if (
        j < m &&
        (i === n || dp[i * width + j + 1]! >= dp[(i + 1) * width + j]!)
      )
        j++
      else i++
    }
    for (let k = 0; k <= suffix; k++) {
      positions[a.length - suffix + k] = b.length - suffix + k
      if (k < suffix) preserved[a.length - suffix + k] = true
    }
    result = { a, b, positions, preserved }
  }
  if (maps.size >= 16) maps.delete(maps.keys().next().value!)
  maps.set(key, result)
  return result
}

/** Banded Levenshtein with an early distance cutoff and shared work budget. */
function distance(
  a: string[],
  b: string[],
  max: number,
  budget: { left: number }
): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = Array<number>(b.length + 1).fill(max + 1)
    next[0] = i
    let best = max + 1
    for (let j = Math.max(1, i - max); j <= Math.min(b.length, i + max); j++) {
      if (--budget.left < 0) return max + 1
      next[j] = Math.min(
        prev[j]! + 1,
        next[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
      best = Math.min(best, next[j]!)
    }
    if (best > max) return max + 1
    prev = next
  }
  return prev[b.length]!
}

/** Compare nearby surrounding characters, not absolute position, to reject repeats. */
function contextPenalty(
  a: string[],
  b: string[],
  start: number,
  end: number,
  s: number,
  e: number
): number {
  let penalty = 0
  for (let k = 1; k <= 12; k++) {
    if (start - k >= 0 && a[start - k] !== b[s - k]) penalty++
    if (end + k - 1 < a.length && a[end + k - 1] !== b[e + k - 1]) penalty++
  }
  return penalty
}

/** Locate an immutable source range in another revision; never change its anchor. */
function mapRange(
  before: string,
  after: string,
  start: number,
  end: number
): SourceLocation {
  const original = Array.from(before)
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > original.length
  )
    return { status: 'unavailable' }
  if (before === after) return { status: 'exact', start, end }
  const map = editMap(before, after)
  if (!map) return { status: 'outdated' }
  const { a, b, positions, preserved } = map
  const projected = positions[start]!
  if (start === end) {
    // An insertion at this boundary or a deleted neighbor makes it ambiguous.
    const left =
      start === 0
        ? projected === 0
        : preserved[start - 1] && positions[start - 1] === projected - 1
    const right = end === a.length ? projected === b.length : preserved[end]
    let matches = 0
    for (let s = 0; s <= b.length; s++)
      if (contextPenalty(a, b, start, end, s, s) === 0) matches++
    return left && right && matches === 1
      ? { status: 'mapped', start: projected, end: projected }
      : { status: 'outdated' }
  }
  const selected = a.slice(start, end)
  const exact: { start: number; end: number; score: number }[] = []
  let work = 0
  for (let s = 0; s <= b.length - selected.length; s++) {
    let equal = true
    for (let k = 0; k < selected.length; k++) {
      if (++work > ANCHOR_MAPPING_LIMITS.fuzzyWork)
        return { status: 'outdated' }
      if (selected[k] !== b[s + k]) {
        equal = false
        break
      }
    }
    if (equal)
      exact.push({
        start: s,
        end: s + selected.length,
        score: contextPenalty(a, b, start, end, s, s + selected.length),
      })
  }
  exact.sort((x, y) => x.score - y.score)
  const best = exact[0]
  const intact =
    preserved.slice(start, end).every(Boolean) &&
    positions[end - 1] === projected + selected.length - 1
  if (
    best &&
    (exact.length === 1 ||
      exact[1]!.score - best.score >= ANCHOR_MAPPING_LIMITS.margin) &&
    ((intact && best.start === projected) ||
      Math.abs(best.start - projected) <= ANCHOR_MAPPING_LIMITS.searchRadius) &&
    (selected.length >= ANCHOR_MAPPING_LIMITS.shortSelection ||
      best.score === 0)
  )
    return { status: 'mapped', start: best.start, end: best.end }
  if (exact.length || selected.length < ANCHOR_MAPPING_LIMITS.shortSelection)
    return { status: 'outdated' }
  const max = Math.min(
    ANCHOR_MAPPING_LIMITS.distance,
    Math.floor(selected.length / 8)
  )
  const budget = { left: ANCHOR_MAPPING_LIMITS.fuzzyWork }
  const candidates: { start: number; end: number; score: number }[] = []
  for (
    let s = Math.max(0, projected - ANCHOR_MAPPING_LIMITS.searchRadius);
    s <= Math.min(b.length, projected + ANCHOR_MAPPING_LIMITS.searchRadius);
    s++
  ) {
    for (let len = selected.length - max; len <= selected.length + max; len++) {
      const e = s + len
      if (e > b.length) continue
      const d = distance(selected, b.slice(s, e), max, budget)
      if (budget.left < 0) return { status: 'outdated' }
      const context = contextPenalty(a, b, start, end, s, e)
      if (d <= max && context <= 4)
        candidates.push({ start: s, end: e, score: d * 4 + context })
    }
  }
  candidates.sort((x, y) => x.score - y.score)
  const candidate = candidates[0]
  if (
    !candidate ||
    (candidates[1] &&
      candidates[1].score - candidate.score < ANCHOR_MAPPING_LIMITS.margin)
  )
    return { status: 'outdated' }
  return { status: 'fuzzy', start: candidate.start, end: candidate.end }
}

const graphemes = new Map<string, Set<number>>()
/** Cache boundaries per source so several comments do not repeatedly segment it. */
function graphemeBoundaries(source: string): Set<number> {
  const cached = graphemes.get(source)
  if (cached) return cached
  const boundaries = new Set([0])
  let offset = 0
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale: undefined,
        options: { granularity: 'grapheme' }
      ) => { segment(source: string): Iterable<{ segment: string }> }
    }
  ).Segmenter
  if (!Segmenter) return boundaries
  for (const part of new Segmenter(undefined, {
    granularity: 'grapheme',
  }).segment(source)) {
    offset += Array.from(part.segment).length
    boundaries.add(offset)
  }
  if (graphemes.size >= 16) graphemes.delete(graphemes.keys().next().value!)
  graphemes.set(source, boundaries)
  return boundaries
}

/** Public mapping rejects new grapheme splits, including combining marks added by edits. */
export function mapSourceRange(
  before: string,
  after: string,
  start: number,
  end: number
): SourceLocation {
  if (
    before.length > ANCHOR_MAPPING_LIMITS.sourceLength * 2 ||
    after.length > ANCHOR_MAPPING_LIMITS.sourceLength * 2
  )
    return { status: 'outdated' }
  const result = mapRange(before, after, start, end)
  if (!('start' in result)) return result
  const original = graphemeBoundaries(before),
    current = graphemeBoundaries(after)
  if (!original.has(start) || !original.has(end))
    return { status: 'unavailable' }
  if (!current.has(result.start) || !current.has(result.end))
    return { status: 'outdated' }
  return result
}

/** Read only transient materialization metadata; it is never a serialized quote. */
export function historicalAnchors(comment: DriveComment): HistoricalAnchor[] {
  const result: HistoricalAnchor[] = []
  for (const message of [
    comment,
    ...(comment.replies ?? []).filter((r) => !r.deleted),
  ]) {
    try {
      const sources = JSON.parse(message.anchor ?? '{}').runme?.anchorSources
      if (Array.isArray(sources))
        for (const entry of sources) {
          if (
            entry?.anchor?.kind === 'cell' &&
            typeof entry.anchor.cell_id === 'string' &&
            (entry.source === undefined || typeof entry.source === 'string') &&
            (entry.anchor.version?.kind === 'operation'
              ? typeof entry.anchor.version.op_id === 'string'
              : entry.anchor.version?.kind === 'revision' &&
                typeof entry.anchor.version.revision_id === 'string') &&
            !result.some(
              (x) => JSON.stringify(x.anchor) === JSON.stringify(entry.anchor)
            )
          )
            result.push(entry)
        }
    } catch {
      /* Legacy anchors have no historical-source projection. */
    }
  }
  return result
}

/** Resolve every anchor independently against one displayed side. */
export function locateComment(
  comment: DriveComment,
  cells: readonly { refId: string; value?: string }[],
  side?: 'base' | 'head'
): LocatedAnchor[] {
  return historicalAnchors(comment).map((entry) => {
    const cellId =
      entry.anchor.kind === 'cell' ? entry.anchor.cell_id : undefined
    const cell = cells.find((c) => c.refId === cellId)
    const range = entry.anchor.kind === 'cell' ? entry.anchor.range : undefined
    const location: SourceLocation =
      entry.source === undefined
        ? { status: 'unavailable' }
        : !cell
          ? { status: 'deleted' }
          : !range
            ? { status: 'cell' }
            : mapSourceRange(
                entry.source,
                cell.value ?? '',
                range.start_index,
                range.end_index
              )
    return { ...entry, location, side }
  })
}

export function isLocated(location: SourceLocation): boolean {
  return ['cell', 'exact', 'mapped', 'fuzzy'].includes(location.status)
}
