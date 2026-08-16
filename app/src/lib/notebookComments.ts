import type { DriveComment } from '../storage/drive'
import {
  RENDERED_MARKDOWN_PROJECTION_NAME,
  RENDERED_MARKDOWN_PROJECTION_VERSION,
  type RenderedMarkdownSelectionDraft,
  type TextPositionSelector,
  type TextQuoteSelector,
  type TextRange,
  buildRenderedMarkdownProjection,
  sha256Text,
  sliceByCodePoint,
} from './markdown/renderedMarkdownProjection'

const RUNME_COMMENT_ANCHOR_VERSION = 2

export type CellCommentAnchor = {
  type: 'cell'
  cellId: string
  version: 1 | 2
  clientCommentId?: string
}

export type CellTextCommentAnchor = {
  type: 'cell-text'
  cellId: string
  version: 2
  surface: 'rendered-markdown'
  state: {
    driveRevisionId: string
    sourceSha256: string
    projection: {
      name: typeof RENDERED_MARKDOWN_PROJECTION_NAME
      version: number
      sha256: string
    }
  }
  selectors: [TextPositionSelector, TextQuoteSelector]
  sourceHints?: TextRange[]
  clientCommentId?: string
}

export type CommentAnchor = CellCommentAnchor | CellTextCommentAnchor

export type CommentDraftTarget =
  | { type: 'cell'; cellId: string }
  | RenderedMarkdownSelectionDraft

export type CommentCellIdentity = {
  refId: string
  value?: string
}

type RunmeCommentAnchorPayload = {
  runme?: {
    version?: number
    type?: string
    kind?: string
    cellId?: string
    surface?: string
    state?: CellTextCommentAnchor['state']
    selectors?: unknown
    sourceHints?: unknown
    clientCommentId?: unknown
    clientOperationId?: unknown
  }
}

export type CommentLocationState =
  | { status: 'cell' }
  | { status: 'exact'; start: number; end: number }
  | { status: 'moved'; start: number; end: number }
  | { status: 'ambiguous'; candidates: TextRange[] }
  | {
      status: 'outdated' | 'projection-unavailable' | 'cell-deleted'
    }

export type CellCommentThread = {
  comment: DriveComment
  anchor: CommentAnchor | null
  cellId: string | null
  orphaned: boolean
  location: CommentLocationState | null
}

export type CellAnchorResolution = {
  cellId: string
  orphaned: boolean
}

export function createCellCommentAnchor(
  cellId: string,
  clientCommentId?: string
): string {
  return JSON.stringify({
    runme: {
      version: RUNME_COMMENT_ANCHOR_VERSION,
      type: 'cell',
      cellId,
      ...(clientCommentId ? { clientCommentId } : {}),
    },
  })
}

export async function createCellTextCommentAnchor(
  target: RenderedMarkdownSelectionDraft,
  driveRevisionId: string,
  clientCommentId?: string
): Promise<string> {
  const [position, quote] = target.selectors
  if (
    sliceByCodePoint(target.projection.text, position.start, position.end) !==
    quote.exact
  ) {
    throw new Error(
      'The rendered Markdown selection no longer matches its projection.'
    )
  }
  const anchor: CellTextCommentAnchor = {
    version: RUNME_COMMENT_ANCHOR_VERSION,
    type: 'cell-text',
    cellId: target.cellId,
    surface: 'rendered-markdown',
    state: {
      driveRevisionId,
      sourceSha256: await sha256Text(target.source),
      projection: {
        name: RENDERED_MARKDOWN_PROJECTION_NAME,
        version: target.projection.version,
        sha256: await sha256Text(target.projection.text),
      },
    },
    selectors: target.selectors,
    ...(target.sourceHints.length > 0
      ? { sourceHints: target.sourceHints }
      : {}),
    ...(clientCommentId ? { clientCommentId } : {}),
  }
  return JSON.stringify({ runme: anchor })
}

export function createPendingCellTextCommentAnchor(
  target: RenderedMarkdownSelectionDraft,
  clientCommentId: string
): string {
  const [position, quote] = target.selectors
  if (
    sliceByCodePoint(target.projection.text, position.start, position.end) !==
    quote.exact
  ) {
    throw new Error(
      'The rendered Markdown selection no longer matches its projection.'
    )
  }
  const anchor: CellTextCommentAnchor = {
    version: RUNME_COMMENT_ANCHOR_VERSION,
    type: 'cell-text',
    cellId: target.cellId,
    surface: 'rendered-markdown',
    state: {
      driveRevisionId: `local-pending:${clientCommentId}`,
      sourceSha256: 'local-pending',
      projection: {
        name: RENDERED_MARKDOWN_PROJECTION_NAME,
        version: target.projection.version,
        sha256: 'local-pending',
      },
    },
    selectors: target.selectors,
    ...(target.sourceHints.length > 0
      ? { sourceHints: target.sourceHints }
      : {}),
    clientCommentId,
  }
  return JSON.stringify({ runme: anchor })
}

function isTextPositionSelector(value: unknown): value is TextPositionSelector {
  if (!value || typeof value !== 'object') {
    return false
  }
  const selector = value as Partial<TextPositionSelector>
  return (
    selector.type === 'TextPositionSelector' &&
    Number.isInteger(selector.start) &&
    Number.isInteger(selector.end) &&
    Number(selector.start) >= 0 &&
    Number(selector.end) > Number(selector.start)
  )
}

function isTextQuoteSelector(value: unknown): value is TextQuoteSelector {
  if (!value || typeof value !== 'object') {
    return false
  }
  const selector = value as Partial<TextQuoteSelector>
  return (
    selector.type === 'TextQuoteSelector' &&
    typeof selector.exact === 'string' &&
    selector.exact.length > 0 &&
    (selector.prefix === undefined || typeof selector.prefix === 'string') &&
    (selector.suffix === undefined || typeof selector.suffix === 'string')
  )
}

function parseSourceHints(value: unknown): TextRange[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const ranges = value.filter((range): range is TextRange =>
    Boolean(
      range &&
        typeof range === 'object' &&
        Number.isInteger((range as TextRange).start) &&
        Number.isInteger((range as TextRange).end) &&
        (range as TextRange).start >= 0 &&
        (range as TextRange).end > (range as TextRange).start
    )
  )
  return ranges.length === value.length ? ranges : undefined
}

export function parseCommentAnchor(
  anchor?: string | null
): CommentAnchor | null {
  if (!anchor) {
    return null
  }

  try {
    const parsed = JSON.parse(anchor) as RunmeCommentAnchorPayload
    const runme = parsed.runme
    const version = runme?.version
    const anchorType =
      version === 1 ? (runme?.type ?? runme?.kind) : runme?.type
    if (
      (version !== 1 && version !== RUNME_COMMENT_ANCHOR_VERSION) ||
      typeof runme?.cellId !== 'string' ||
      !runme.cellId.trim()
    ) {
      return null
    }

    if (anchorType === 'cell') {
      const clientCommentId =
        typeof runme.clientCommentId === 'string'
          ? runme.clientCommentId
          : typeof runme.clientOperationId === 'string'
            ? runme.clientOperationId
            : undefined
      return {
        type: 'cell',
        cellId: runme.cellId,
        version,
        ...(clientCommentId ? { clientCommentId } : {}),
      }
    }

    if (
      version !== RUNME_COMMENT_ANCHOR_VERSION ||
      anchorType !== 'cell-text' ||
      runme.surface !== 'rendered-markdown' ||
      !runme.state ||
      typeof runme.state.driveRevisionId !== 'string' ||
      !runme.state.driveRevisionId ||
      typeof runme.state.sourceSha256 !== 'string' ||
      runme.state.projection?.name !== RENDERED_MARKDOWN_PROJECTION_NAME ||
      !Number.isInteger(runme.state.projection.version) ||
      typeof runme.state.projection.sha256 !== 'string' ||
      !Array.isArray(runme.selectors) ||
      runme.selectors.length !== 2 ||
      !isTextPositionSelector(runme.selectors[0]) ||
      !isTextQuoteSelector(runme.selectors[1])
    ) {
      return null
    }
    const sourceHints = parseSourceHints(runme.sourceHints)
    if (runme.sourceHints !== undefined && !sourceHints) {
      return null
    }
    const clientCommentId =
      typeof runme.clientCommentId === 'string'
        ? runme.clientCommentId
        : typeof runme.clientOperationId === 'string'
          ? runme.clientOperationId
          : undefined
    return {
      type: 'cell-text',
      cellId: runme.cellId,
      version,
      surface: runme.surface,
      state: runme.state,
      selectors: [runme.selectors[0], runme.selectors[1]],
      ...(sourceHints ? { sourceHints } : {}),
      ...(clientCommentId ? { clientCommentId } : {}),
    }
  } catch {
    return null
  }
}

export function parseCellCommentAnchor(
  anchor?: string | null
): CellCommentAnchor | null {
  const parsed = parseCommentAnchor(anchor)
  return parsed?.type === 'cell' ? parsed : null
}

export function groupCommentsByCell(
  comments: DriveComment[],
  cells: Iterable<CommentCellIdentity>
): Map<string, DriveComment[]> {
  const identities = [...cells]
  const byCell = new Map<string, DriveComment[]>()
  comments.forEach((comment) => {
    if (comment.deleted || comment.resolved) {
      return
    }
    const anchor = parseCommentAnchor(comment.anchor)
    if (!anchor) {
      return
    }
    const resolution = resolveCellAnchor(anchor.cellId, identities)
    if (resolution.orphaned) {
      return
    }
    const existing = byCell.get(resolution.cellId) ?? []
    existing.push(comment)
    byCell.set(resolution.cellId, existing)
  })
  return byCell
}

export function toCellCommentThreads(
  comments: DriveComment[],
  cells: Iterable<CommentCellIdentity>
): CellCommentThread[] {
  const identities = [...cells]
  return comments
    .filter((comment) => !comment.deleted)
    .map((comment) => {
      const anchor = parseCommentAnchor(comment.anchor)
      if (!anchor) {
        return {
          comment,
          anchor: null,
          cellId: null,
          orphaned: false,
          location: null,
        }
      }
      const resolution = resolveCellAnchor(anchor.cellId, identities)
      const cell = identities.find(
        (candidate) => candidate.refId === resolution.cellId
      )
      return {
        comment,
        anchor,
        cellId: resolution.cellId,
        orphaned: resolution.orphaned,
        location:
          anchor.type === 'cell'
            ? { status: 'cell' }
            : resolution.orphaned
              ? { status: 'cell-deleted' }
              : resolveRenderedTextAnchor(anchor, cell?.value ?? ''),
      }
    })
}

export function resolveCellAnchor(
  anchoredCellId: string,
  cells: CommentCellIdentity[]
): CellAnchorResolution {
  const exact = cells.find((cell) => cell.refId === anchoredCellId)
  if (exact) {
    return { cellId: exact.refId, orphaned: false }
  }
  return { cellId: anchoredCellId, orphaned: true }
}

function occurrenceRanges(text: string, quote: string): TextRange[] {
  const ranges: TextRange[] = []
  let from = 0
  while (from <= text.length) {
    const index = text.indexOf(quote, from)
    if (index < 0) {
      break
    }
    const start = Array.from(text.slice(0, index)).length
    ranges.push({ start, end: start + Array.from(quote).length })
    from = index + Math.max(quote.length, 1)
  }
  return ranges
}

function contextScore(
  text: string,
  range: TextRange,
  quote: TextQuoteSelector
): number {
  let score = 0
  if (
    quote.prefix &&
    sliceByCodePoint(
      text,
      Math.max(0, range.start - Array.from(quote.prefix).length),
      range.start
    ) === quote.prefix
  ) {
    score += 1
  }
  if (
    quote.suffix &&
    sliceByCodePoint(
      text,
      range.end,
      range.end + Array.from(quote.suffix).length
    ) === quote.suffix
  ) {
    score += 1
  }
  return score
}

export function resolveRenderedTextAnchor(
  anchor: CellTextCommentAnchor,
  source: string
): CommentLocationState {
  if (
    anchor.state.projection.name !== RENDERED_MARKDOWN_PROJECTION_NAME ||
    anchor.state.projection.version !== RENDERED_MARKDOWN_PROJECTION_VERSION
  ) {
    return { status: 'projection-unavailable' }
  }
  const projection = buildRenderedMarkdownProjection(source)
  const [position, quote] = anchor.selectors
  if (
    sliceByCodePoint(projection.text, position.start, position.end) ===
    quote.exact
  ) {
    return { status: 'exact', start: position.start, end: position.end }
  }
  const occurrences = occurrenceRanges(projection.text, quote.exact)
  if (occurrences.length === 0) {
    return { status: 'outdated' }
  }
  const scored = occurrences.map((range) => ({
    range,
    score: contextScore(projection.text, range, quote),
  }))
  const bestScore = Math.max(...scored.map((candidate) => candidate.score))
  const best = scored
    .filter((candidate) => candidate.score === bestScore)
    .map((candidate) => candidate.range)
  if (best.length === 1) {
    return { status: 'moved', ...best[0]! }
  }
  return { status: 'ambiguous', candidates: best }
}
