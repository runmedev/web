import {
  buildRenderedMarkdownProjection,
  sliceByCodePoint,
} from './renderedMarkdownProjection'

const projections = new Map<
  string,
  ReturnType<typeof buildRenderedMarkdownProjection>
>()

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
  let projection = projections.get(source)
  if (!projection) {
    projection = buildRenderedMarkdownProjection(source)
    if (projections.size >= 16)
      projections.delete(projections.keys().next().value!)
    projections.set(source, projection)
  }
  return projection.segments.flatMap((segment) =>
    segment.sourceRanges.flatMap((range) => {
      const s = Math.max(from, range.start),
        e = Math.min(to, range.end)
      const text = sliceByCodePoint(
        projection.text,
        segment.projectionStart,
        segment.projectionEnd
      )
      if (s >= e || source.slice(range.start, range.end) !== text) return []
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
