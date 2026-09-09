export type CommentSourceRange = {
  start: number
  end: number
  threadId: string
  side?: 'base' | 'head'
}

/** Split only presentation spans; outer diff runs retain original source offsets. */
export function CommentedSourceRun({
  value,
  base,
  head,
  ranges = [],
  onSelect,
}: {
  value: string
  base?: number
  head?: number
  ranges?: CommentSourceRange[]
  onSelect?: (id: string) => void
}) {
  const overlaps = ranges.flatMap((r) => {
    const offset = r.side === 'base' ? base : head
    if (offset === undefined) return []
    const start = Math.max(0, r.start - offset),
      end = Math.min(value.length, r.end - offset)
    return start < end ? [{ ...r, start, end }] : []
  })
  const boundaries = [
    ...new Set([0, value.length, ...overlaps.flatMap((r) => [r.start, r.end])]),
  ].sort((a, b) => a - b)
  return (
    <>
      {boundaries.slice(0, -1).map((start, i) => {
        const end = boundaries[i + 1]!,
          ids = overlaps
            .filter((r) => r.start <= start && r.end >= end)
            .map((r) => r.threadId)
        return ids.length ? (
          <span
            key={start}
            className="border-b-2 border-blue-500 cursor-pointer"
            role="button"
            tabIndex={0}
            aria-label="Open comment on this text"
            data-comment-thread-id={ids[0]}
            onClick={(e) => {
              if (window.getSelection()?.isCollapsed !== false) {
                e.stopPropagation()
                onSelect?.(ids[0]!)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onSelect?.(ids[0]!)
              }
            }}
          >
            {value.slice(start, end)}
          </span>
        ) : (
          value.slice(start, end)
        )
      })}
    </>
  )
}
