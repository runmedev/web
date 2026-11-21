import {
  RENDERED_MARKDOWN_PROJECTION_NAME,
  RENDERED_MARKDOWN_PROJECTION_VERSION,
  buildRenderedMarkdownProjection,
  sha256Text,
  sourceRangeForRenderedSelection,
} from '../markdown/renderedMarkdownProjection'
import type { Anchor, VersionRef } from './records'
import type { RunmeOperation } from './types'
import { anchorSource, codePointRange } from './versions'

/** Convert a captured UI/legacy anchor only when its immutable source matches.
 * The captured selection supplies both source boundaries. Quotes are validated here.
 */
export async function sourceAnchorsFromLegacy(
  operations: RunmeOperation[],
  target: any,
  version: VersionRef
): Promise<Anchor[]> {
  if (typeof target?.cellId !== 'string')
    throw new Error('A cell anchor is required')
  const anchor: Anchor = {
    kind: 'cell',
    cell_id: target.cellId,
    version,
    surface: 'source',
  }
  const source = anchorSource(operations, anchor)!
  if (target.type === 'cell-text') {
    if (target.state?.sourceSha256 !== (await sha256Text(source)))
      throw new Error('Captured source has changed')
    const projection = buildRenderedMarkdownProjection(source)
    const position = target.selectors?.find(
      (s: any) => s.type === 'TextPositionSelector'
    )
    const quote = target.selectors?.find(
      (s: any) => s.type === 'TextQuoteSelector'
    )
    if (
      !position ||
      !quote ||
      target.state.projection?.name !== RENDERED_MARKDOWN_PROJECTION_NAME ||
      target.state.projection?.version !==
        RENDERED_MARKDOWN_PROJECTION_VERSION ||
      !Number.isSafeInteger(position.start) ||
      !Number.isSafeInteger(position.end) ||
      position.start < 0 ||
      position.end <= position.start ||
      position.end > Array.from(projection.text).length ||
      target.state.projection?.sha256 !== (await sha256Text(projection.text)) ||
      Array.from(projection.text)
        .slice(position.start, position.end)
        .join('') !== quote.exact
    )
      throw new Error('Rendered selection projection changed')
    const range = sourceRangeForRenderedSelection(
      projection,
      source,
      position.start,
      position.end
    )
    if (!range) throw new Error('Rendered selection has no source mapping')
    return [
      {
        ...anchor,
        selection_surface: 'rendered-markdown',
        range: codePointRange(source, range.start, range.end),
      },
    ]
  }
  const range = target.diffTarget?.sourceRange
  if (range) {
    if (range.unit !== 'utf-16') throw new Error('Unknown legacy range unit')
    anchor.range = codePointRange(source, range.start, range.end)
  }
  const quote = target.diffTarget?.quote ?? target.quote
  if (quote && anchorSource(operations, anchor) !== quote)
    throw new Error(
      'Quoted text does not match historical source; refusing to guess offsets'
    )
  return [anchor]
}
