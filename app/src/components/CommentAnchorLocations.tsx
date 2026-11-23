import { renderedSelectionQuote } from '../lib/markdown/sourceCommentProjection'
import type { LocatedAnchor } from '../lib/commentAnchorMapping'
import { isLocated } from '../lib/commentAnchorMapping'
import { useId } from 'react'

/** Older comments can contain several fragments for the same historical cell.
 * Share one disclosure without inferring which fragments were selected together.
 */
function historicalGroups(locations: LocatedAnchor[]): LocatedAnchor[][] {
  const groups: LocatedAnchor[][] = []
  const outdated = new Map<string, LocatedAnchor[]>()
  for (const entry of locations) {
    const { anchor } = entry
    if (
      entry.location.status === 'outdated' &&
      anchor.kind === 'cell' &&
      anchor.range &&
      !entry.side
    ) {
      const key = JSON.stringify([
        anchor.cell_id,
        anchor.version.kind,
        anchor.version.kind === 'revision'
          ? anchor.version.revision_id
          : anchor.version.op_id,
      ])
      const group = outdated.get(key)
      if (group) group.push(entry)
      else {
        const group = [entry]
        outdated.set(key, group)
        groups.push(group)
      }
    } else groups.push([entry])
  }
  return groups
}

/** Resolve historical excerpts in the surface in which the selection was made. */
export function historicalQuote({ anchor, source }: LocatedAnchor) {
  if (source === undefined || anchor.kind !== 'cell' || !anchor.range)
    return source
  const { start_index, end_index } = anchor.range
  if (anchor.selection_surface === 'rendered-markdown') {
    const quote = renderedSelectionQuote(source, start_index, end_index)
    if (quote !== undefined) return quote
  }
  return Array.from(source).slice(start_index, end_index).join('')
}

/** One conversation can expose several independent locations and historical contexts. */
export function CommentAnchorLocations({
  locations,
  onSelect,
  cellLabels,
}: {
  locations: LocatedAnchor[]
  cellLabels?: ReadonlyMap<string, string>
  onSelect?: (location: LocatedAnchor) => void
}) {
  const id = useId()
  if (!locations.length) return null
  return (
    <div
      id={`comment-anchor-locations-${id}`}
      className="my-2 space-y-2 text-xs"
    >
      {historicalGroups(locations).map((group, index) => {
        const entry = group[0]!
        const anchor = entry.anchor
        const version =
          anchor.version.kind === 'revision'
            ? anchor.version.revision_id
            : anchor.version.op_id
        const changedSelection =
          anchor.kind === 'cell' &&
          anchor.range &&
          !entry.side &&
          entry.location.status === 'outdated'
        const cellLabel =
          anchor.kind === 'cell'
            ? (cellLabels?.get(anchor.cell_id) ??
              `Cell ${anchor.cell_id.slice(0, 8)}`)
            : ''
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
            {changedSelection ? (
              <p>{cellLabel} has changed since you commented.</p>
            ) : (
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
            )}
            <details onClick={(event) => event.stopPropagation()}>
              <summary className="cursor-pointer text-nb-text-muted">
                {changedSelection
                  ? group.length === 1
                    ? 'View original selection'
                    : 'View original passages'
                  : 'Inspect historical context'}
              </summary>
              <p className="break-all">Revision: {version}</p>
              {group.map((fragment, fragmentIndex) => (
                <blockquote
                  key={fragmentIndex}
                  className="max-h-32 overflow-auto whitespace-pre-wrap border-l-2 border-nb-accent pl-2"
                >
                  {historicalQuote(fragment) ?? 'Historical source unavailable'}
                </blockquote>
              ))}
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
