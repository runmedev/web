import type { DriveComment } from '../storage/drive'
import { legacyCellRefIds } from './cellIdentity'

const RUNME_COMMENT_ANCHOR_VERSION = 2

export type CellCommentAnchor = {
  type: 'cell'
  cellId: string
  version: 1 | 2
  cellIdKind?: 'runme-ref-id' | 'ipynb-cell-id'
}

export type CommentCellIdentity = {
  refId: string
  metadata?: Record<string, string>
}

type RunmeCommentAnchorPayload = {
  runme?: {
    version?: number
    type?: string
    kind?: string
    cellId?: string
    cellIdKind?: string
  }
}

export type CellCommentThread = {
  comment: DriveComment
  cellId: string | null
  orphaned: boolean
  ambiguous: boolean
}

type CellAnchorResolution = {
  cellId: string
  orphaned: boolean
  ambiguous: boolean
}

export function createCellCommentAnchor(cellId: string): string {
  return JSON.stringify({
    runme: {
      version: RUNME_COMMENT_ANCHOR_VERSION,
      type: 'cell',
      cellId,
    },
  })
}

export function parseCellCommentAnchor(
  anchor?: string | null
): CellCommentAnchor | null {
  if (!anchor) {
    return null
  }

  try {
    const parsed = JSON.parse(anchor) as RunmeCommentAnchorPayload
    const version = parsed.runme?.version
    const anchorType =
      version === 1
        ? (parsed.runme?.type ?? parsed.runme?.kind)
        : parsed.runme?.type
    if (
      (version !== 1 && version !== RUNME_COMMENT_ANCHOR_VERSION) ||
      anchorType !== 'cell' ||
      typeof parsed.runme?.cellId !== 'string' ||
      !parsed.runme.cellId.trim()
    ) {
      return null
    }

    if (version === 1) {
      const cellIdKind = parsed.runme.cellIdKind ?? 'runme-ref-id'
      if (cellIdKind !== 'runme-ref-id' && cellIdKind !== 'ipynb-cell-id') {
        return null
      }
      return {
        type: 'cell',
        cellId: parsed.runme.cellId,
        version,
        cellIdKind,
      }
    }

    return {
      type: 'cell',
      cellId: parsed.runme.cellId,
      version,
    }
  } catch {
    return null
  }
}

export function groupCommentsByCell(
  comments: DriveComment[],
  cells: Iterable<CommentCellIdentity> = []
): Map<string, DriveComment[]> {
  const identities = [...cells]
  const byCell = new Map<string, DriveComment[]>()
  comments.forEach((comment) => {
    if (comment.deleted || comment.resolved) {
      return
    }
    const anchor = parseCellCommentAnchor(comment.anchor)
    if (!anchor) {
      return
    }
    const resolution = resolveCellAnchor(anchor.cellId, identities)
    if (resolution.orphaned || resolution.ambiguous) {
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
  cells: Iterable<CommentCellIdentity> = []
): CellCommentThread[] {
  const identities = [...cells]
  return comments
    .filter((comment) => !comment.deleted)
    .map((comment) => {
      const anchor = parseCellCommentAnchor(comment.anchor)
      if (!anchor) {
        return {
          comment,
          cellId: null,
          orphaned: false,
          ambiguous: false,
        }
      }
      const resolution = resolveCellAnchor(anchor.cellId, identities)
      return {
        comment,
        cellId: resolution.cellId,
        orphaned: resolution.orphaned,
        ambiguous: resolution.ambiguous,
      }
    })
}

function resolveCellAnchor(
  anchoredCellId: string,
  cells: CommentCellIdentity[]
): CellAnchorResolution {
  if (cells.length === 0) {
    return { cellId: anchoredCellId, orphaned: false, ambiguous: false }
  }

  const exact = cells.find((cell) => cell.refId === anchoredCellId)
  if (exact) {
    return { cellId: exact.refId, orphaned: false, ambiguous: false }
  }

  const candidates = new Set<string>()
  for (const cell of cells) {
    const aliases = [
      `code_${cell.refId}`,
      `markup_${cell.refId}`,
      ...legacyCellRefIds(cell.metadata),
    ]
    if (aliases.includes(anchoredCellId)) {
      candidates.add(cell.refId)
    }
  }

  if (candidates.size === 1) {
    return {
      cellId: [...candidates][0]!,
      orphaned: false,
      ambiguous: false,
    }
  }
  if (candidates.size > 1) {
    return { cellId: anchoredCellId, orphaned: false, ambiguous: true }
  }
  return { cellId: anchoredCellId, orphaned: true, ambiguous: false }
}
