import {
  buildRenderedMarkdownProjection,
  sliceByCodePoint,
} from './renderedMarkdownProjection'

const projections = new Map<
  string,
  ReturnType<typeof buildRenderedMarkdownProjection>
>()

function projectionFor(source: string) {
  let projection = projections.get(source)
  if (!projection) {
    projection = buildRenderedMarkdownProjection(source)
    if (projections.size >= 16)
      projections.delete(projections.keys().next().value!)
    projections.set(source, projection)
  }
  return projection
}

/** Project only source spans whose exact text survives Markdown rendering.
 * Syntax, link destinations and ambiguous escapes must not underline other text.
 */
export function projectSourceCommentRange(
  source: string,
  start: number,
  end: number
): { start: number; end: number }[] {
  const points = Array.from(source)
  const from = points.slice(0, start).join('').length,
    to = points.slice(0, end).join('').length
  const projection = projectionFor(source)
  const renderedPoints = Array.from(projection.text)
  return projection.segments.flatMap((segment) =>
    segment.sourceRanges.flatMap((range) => {
      const s = Math.max(from, range.start),
        e = Math.min(to, range.end)
      if (s >= e) return []
      const text = renderedPoints
        .slice(segment.projectionStart, segment.projectionEnd)
        .join('')
      if (source.slice(range.start, range.end) !== text) {
        // A transformed node (for example an entity) maps as a whole.
        return s === range.start && e === range.end
          ? [{ start: segment.projectionStart, end: segment.projectionEnd }]
          : []
      }
      return [
        {
          start:
            segment.projectionStart +
            Array.from(source.slice(range.start, s)).length,
          end:
            segment.projectionStart +
            Array.from(source.slice(range.start, e)).length,
        },
      ]
    })
  )
}

/** Visible extent of one continuous source selection across Markdown elements. */
export function renderedSelectionRange(
  source: string,
  start: number,
  end: number
) {
  const ranges = projectSourceCommentRange(source, start, end)
  const first = ranges[0],
    last = ranges[ranges.length - 1]
  return first && last ? { start: first.start, end: last.end } : undefined
}

export function renderedSelectionQuote(
  source: string,
  start: number,
  end: number
) {
  const range = renderedSelectionRange(source, start, end)
  return (
    range &&
    sliceByCodePoint(projectionFor(source).text, range.start, range.end)
  )
}
