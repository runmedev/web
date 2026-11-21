import type { LocatedAnchor } from '../lib/commentAnchorMapping'
import { isLocated } from '../lib/commentAnchorMapping'
import { useId } from 'react'

/** Coalesce contiguous pieces of one selection while retaining distinct locations. */
function groupAdjacentLocations(locations: LocatedAnchor[]): LocatedAnchor[] {
  const groups: LocatedAnchor[] = []
  for (const entry of locations) {
    const previous = groups[groups.length - 1]
    const a = previous?.anchor
    const b = entry.anchor
    if (
      previous &&
      a?.kind === 'cell' &&
      b.kind === 'cell' &&
      a.range &&
      b.range &&
      !previous.side &&
      !entry.side &&
      a.cell_id === b.cell_id &&
      a.selection_surface === 'rendered-markdown' &&
      b.selection_surface === 'rendered-markdown' &&
      JSON.stringify(a.version) === JSON.stringify(b.version) &&
      previous.source === entry.source &&
      previous.location.status === entry.location.status &&
      'start' in previous.location &&
      'start' in entry.location &&
      a.range.end_index <= b.range.start_index &&
      b.range.start_index - a.range.end_index <= 16 &&
      previous.source !== undefined &&
      /^[\s*_`~\[\]()!#>-]*$/.test(
        Array.from(previous.source)
          .slice(a.range.end_index, b.range.start_index)
          .join('')
      ) &&
      previous.location.end <= entry.location.start &&
      entry.location.start - previous.location.end ===
        b.range.start_index - a.range.end_index
    ) {
      groups[groups.length - 1] = {
        ...previous,
        anchor: { ...a, range: { ...a.range, end_index: b.range.end_index } },
        location: { ...previous.location, end: entry.location.end },
      }
    } else groups.push(entry)
  }
  return groups
}

/** One conversation can expose several independent locations and historical contexts. */
export function CommentAnchorLocations({
  locations,
  onSelect,
}: {
  locations: LocatedAnchor[]
  onSelect?: (location: LocatedAnchor) => void
}) {
  const id = useId()
  if (!locations.length) return null
  return (
    <div
      id={`comment-anchor-locations-${id}`}
      className="my-2 space-y-2 text-xs"
    >
      {groupAdjacentLocations(locations).map((entry, index) => {
        const anchor = entry.anchor
        const version =
          anchor.version.kind === 'revision'
            ? anchor.version.revision_id
            : anchor.version.op_id
        const quote =
          entry.source === undefined
            ? undefined
            : anchor.kind === 'cell' && anchor.range
              ? Array.from(entry.source)
                  .slice(anchor.range.start_index, anchor.range.end_index)
                  .join('')
              : entry.source
        const status =
          entry.location.status === 'deleted'
            ? 'Deleted cell'
            : entry.location.status === 'outdated'
              ? 'Outdated anchor'
              : entry.location.status === 'unavailable'
                ? 'Unavailable anchor'
                : entry.location.status === 'fuzzy'
                  ? 'Matched nearby text'
                  : 'Located'
        return (
          <div
            id={`comment-anchor-location-${id}-${index}`}
            key={`${index}-${entry.side}`}
          >
            <button
              type="button"
              className="max-w-full break-words text-left text-nb-accent disabled:text-nb-text-muted"
              title={
                anchor.kind === 'cell' ? `Cell ${anchor.cell_id}` : undefined
              }
              disabled={
                !onSelect ||
                (!isLocated(entry.location) &&
                  !(anchor.kind === 'cell' && anchor.output_item))
              }
              onClick={(event) => {
                event.stopPropagation()
                onSelect?.(entry)
              }}
            >
              {entry.side
                ? `${entry.side === 'base' ? 'Start' : 'End'} · `
                : ''}
              {anchor.kind === 'cell' && anchor.output_item
                ? 'View saved output'
                : status}
              {anchor.kind === 'cell'
                ? ` · Cell ${anchor.cell_id.slice(0, 8)}`
                : ''}
            </button>
            <details>
              <summary className="cursor-pointer text-nb-text-muted">
                Inspect historical context
              </summary>
              <p className="break-all">Revision: {version}</p>
              <blockquote className="max-h-32 overflow-auto whitespace-pre-wrap border-l-2 border-nb-accent pl-2">
                {quote ?? 'Historical source unavailable'}
              </blockquote>
              {entry.source !== undefined &&
                anchor.kind === 'cell' &&
                anchor.range && (
                  <details>
                    <summary>Whole cell at this revision</summary>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
                      {entry.source}
                    </pre>
                  </details>
                )}
            </details>
          </div>
        )
      })}
    </div>
  )
}
