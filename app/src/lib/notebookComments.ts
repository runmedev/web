import type { DriveComment } from '../storage/drive'

const RUNME_COMMENT_ANCHOR_VERSION = 1

export type CellCommentAnchor = {
  kind: 'cell'
  cellId: string
}

type RunmeCommentAnchorPayload = {
  runme?: {
    version?: number
    kind?: string
    cellId?: string
  }
}

export type CellCommentThread = {
  comment: DriveComment
  cellId: string | null
}

export function createCellCommentAnchor(cellId: string): string {
  return JSON.stringify({
    runme: {
      version: RUNME_COMMENT_ANCHOR_VERSION,
      kind: 'cell',
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
    if (
      parsed.runme?.version !== RUNME_COMMENT_ANCHOR_VERSION ||
      parsed.runme.kind !== 'cell' ||
      typeof parsed.runme.cellId !== 'string' ||
      !parsed.runme.cellId.trim()
    ) {
      return null
    }

    return {
      kind: 'cell',
      cellId: parsed.runme.cellId,
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
  comments: DriveComment[]
): CellCommentThread[] {
  return comments
    .filter((comment) => !comment.deleted)
    .map((comment) => ({
      comment,
      cellId: parseCellCommentAnchor(comment.anchor)?.cellId ?? null,
    }))
}
