export type InlineDiffKind = 'equal' | 'inserted' | 'deleted'

export interface InlineDiffSegment {
  kind: InlineDiffKind
  value: string
}

// Bound quadratic work across the entire cell, not by its number of words.
// Large inputs still retain matching edges and ordered unique-token anchors.
const MAX_MATRIX_ENTRIES = 1_000_000

/** Coalesce adjacent runs without changing the exact source text. */
function append(
  segments: InlineDiffSegment[],
  kind: InlineDiffKind,
  value: string
): void {
  if (!value) return
  const previous = segments.at(-1)
  if (previous?.kind === kind) previous.value += value
  else segments.push({ kind, value })
}

/** Find an ordered set of unique shared tokens in O(n log n) time. */
function anchors(left: string[], right: string[]): [number, number][] {
  const uniquePositions = (values: string[]): Map<string, number> => {
    const positions = new Map<string, number>()
    values.forEach((value, index) => {
      positions.set(value, positions.has(value) ? -1 : index)
    })
    return positions
  }
  const leftPositions = uniquePositions(left)
  const rightPositions = uniquePositions(right)
  const pairs: [number, number][] = []
  left.forEach((value, index) => {
    const other = rightPositions.get(value)
    if (
      leftPositions.get(value) === index &&
      other !== undefined &&
      other >= 0
    ) {
      pairs.push([index, other])
    }
  })
  // Longest increasing subsequence of right positions: moved text must not
  // produce crossing matches (which would corrupt comment selection offsets).
  const tails: number[] = []
  const previous = new Int32Array(pairs.length).fill(-1)
  pairs.forEach((pair, index) => {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (pairs[tails[middle]][1] < pair[1]) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[index] = tails[low - 1]
    tails[low] = index
  })
  const result: [number, number][] = []
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) {
    result.push(pairs[index])
  }
  return result.reverse()
}

/** Align tokens with bounded LCS work, retaining anchors outside coarse gaps. */
function diffSequence(
  left: string[],
  right: string[],
  budget: { remaining: number },
  useAnchors = true
): InlineDiffSegment[] {
  const result: InlineDiffSegment[] = []
  let start = 0
  let leftEnd = left.length
  let rightEnd = right.length
  while (start < leftEnd && start < rightEnd && left[start] === right[start]) {
    start += 1
  }
  while (
    leftEnd > start &&
    rightEnd > start &&
    left[leftEnd - 1] === right[rightEnd - 1]
  ) {
    leftEnd -= 1
    rightEnd -= 1
  }
  append(result, 'equal', left.slice(0, start).join(''))
  const a = left.slice(start, leftEnd)
  const b = right.slice(start, rightEnd)
  const entries = (a.length + 1) * (b.length + 1)
  if (!a.length || !b.length) {
    append(result, 'deleted', a.join(''))
    append(result, 'inserted', b.join(''))
  } else if (entries <= budget.remaining) {
    budget.remaining -= entries
    const width = b.length + 1
    const table = new Uint32Array(entries)
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        append(result, 'equal', a[i++])
        j += 1
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        append(result, 'deleted', a[i++])
      } else append(result, 'inserted', b[j++])
    }
    append(result, 'deleted', a.slice(i).join(''))
    append(result, 'inserted', b.slice(j).join(''))
  } else {
    let i = 0
    let j = 0
    // Only one anchor subdivision is allowed per call, bounding recursion.
    const matches = useAnchors ? anchors(a, b) : []
    for (const [nextI, nextJ] of matches) {
      for (const segment of diffSequence(
        a.slice(i, nextI),
        b.slice(j, nextJ),
        budget,
        false
      )) {
        append(result, segment.kind, segment.value)
      }
      append(result, 'equal', a[nextI])
      i = nextI + 1
      j = nextJ + 1
    }
    if (matches.length) {
      for (const segment of diffSequence(
        a.slice(i),
        b.slice(j),
        budget,
        false
      )) {
        append(result, segment.kind, segment.value)
      }
    } else {
      append(result, 'deleted', a.join(''))
      append(result, 'inserted', b.join(''))
    }
  }
  append(result, 'equal', left.slice(leftEnd).join(''))
  return result
}

/**
 * Preserve unchanged lines, then refine each changed block into word runs.
 * Whitespace and Unicode are never normalized: concatenating non-inserted or
 * non-deleted runs reconstructs each endpoint, keeping comment offsets valid.
 */
export function diffInlineText(
  before: string,
  after: string
): InlineDiffSegment[] {
  if (before === after) return before ? [{ kind: 'equal', value: before }] : []
  const lines = (value: string): string[] =>
    value.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const words = (value: string): string[] =>
    value.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []
  const budget = { remaining: MAX_MATRIX_ENTRIES }
  const blocks = diffSequence(lines(before), lines(after), budget)
  const result: InlineDiffSegment[] = []
  let removed = ''
  let added = ''
  // Refinement is local to a changed block; unchanged headings/paragraphs
  // cannot be swallowed by an expensive rewrite elsewhere in the cell.
  const flush = (): void => {
    for (const segment of diffSequence(words(removed), words(added), budget)) {
      append(result, segment.kind, segment.value)
    }
    removed = ''
    added = ''
  }
  for (const block of blocks) {
    if (block.kind === 'deleted') removed += block.value
    else if (block.kind === 'inserted') added += block.value
    else {
      flush()
      append(result, 'equal', block.value)
    }
  }
  flush()
  return result
}
