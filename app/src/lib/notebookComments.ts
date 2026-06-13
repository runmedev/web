import type { DriveComment } from '../storage/drive'

const RUNME_COMMENT_ANCHOR_VERSION = 1

export type CellCommentAnchor = {
  type: 'cell'
  cellId: string
  cellIdKind: 'runme-ref-id' | 'ipynb-cell-id'
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
}

export function createCellCommentAnchor(cellId: string): string {
  return JSON.stringify({
    runme: {
      version: RUNME_COMMENT_ANCHOR_VERSION,
      type: 'cell',
      cellId,
      cellIdKind: 'runme-ref-id',
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
    const anchorType = parsed.runme?.type ?? parsed.runme?.kind
    const cellIdKind = parsed.runme?.cellIdKind ?? 'runme-ref-id'
    if (
      parsed.runme?.version !== RUNME_COMMENT_ANCHOR_VERSION ||
      anchorType !== 'cell' ||
      typeof parsed.runme.cellId !== 'string' ||
      !parsed.runme.cellId.trim() ||
      (cellIdKind !== 'runme-ref-id' && cellIdKind !== 'ipynb-cell-id')
    ) {
      return null
    }

    return {
      type: 'cell',
      cellId: parsed.runme.cellId,
      cellIdKind,
    }
  } catch {
    return null
  }
}

export function groupCommentsByCell(
  comments: DriveComment[]
): Map<string, DriveComment[]> {
  const byCell = new Map<string, DriveComment[]>()
  comments.forEach((comment) => {
    if (comment.deleted || comment.resolved) {
      return
    }
    const anchor = parseCellCommentAnchor(comment.anchor)
    if (!anchor) {
      return
    }
    const existing = byCell.get(anchor.cellId) ?? []
    existing.push(comment)
    byCell.set(anchor.cellId, existing)
  })
  return byCell
}

export function toCellCommentThreads(
  comments: DriveComment[],
  knownCellIds: Set<string> = new Set()
): CellCommentThread[] {
  return comments
    .filter((comment) => !comment.deleted)
    .map((comment) => {
      const anchor = parseCellCommentAnchor(comment.anchor)
      return {
        comment,
        cellId: anchor?.cellId ?? null,
        orphaned: Boolean(
          anchor?.cellId &&
            knownCellIds.size > 0 &&
            !knownCellIds.has(anchor.cellId)
        ),
      }
    })
}
