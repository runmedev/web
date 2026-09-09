import type { LocatedAnchor } from '../lib/commentAnchorMapping'
import { isLocated } from '../lib/commentAnchorMapping'
import { useId } from 'react'

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
      {locations.map((entry, index) => {
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
              disabled={!onSelect || !isLocated(entry.location)}
              onClick={() => onSelect?.(entry)}
            >
              {entry.side
                ? `${entry.side === 'base' ? 'Start' : 'End'} · `
                : ''}
              {status}
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
