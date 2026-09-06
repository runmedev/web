import type { DiffCommentTarget } from './diffCommentAnchor'
import { materializeOperationLog } from './materialize'
import { materializedLogToNotebook } from './notebook'
import { committedOperationIds, orderOperationSet } from './order'
import {
  computeReviewDiff,
  normalizeReviewCellIds,
  reviewIdentityKey,
} from './reviewScope'
import { revisionKey } from './revisions'
import type { RunmeOperation } from './types'

// Preserve old journal values; new reviews use the scoped assessment wording.
export type ReviewOutcome =
  | 'comment'
  | 'approve'
  | 'request_changes'
  | 'good_enough'
  | 'needs_more_work'
export const REVIEW_OUTCOMES: ReviewOutcome[] = [
  'comment',
  'approve',
  'request_changes',
  'good_enough',
  'needs_more_work',
]
export type Attribution = {
  displayName: string
  kind: 'human' | 'agent' | 'service-account' | 'unknown'
  source?: 'google-drive'
  authenticatedPrincipal?: string
}
export interface ReviewRoundRecord {
  id: string
  title: string
  baseOperationIds: string[]
  headOperationIds: string[]
  cellIds?: string[]
  previousReviewId?: string
  author: Attribution
  aliases?: string[]
}

/** Labels are attribution, never authentication or an operation actor override. */
export function normalizeAttribution(
  author?: Attribution,
  preserveIdentity = false
): Attribution {
  if (!author?.displayName?.trim())
    return { displayName: 'unknown', kind: 'unknown' }
  if (!['human', 'agent', 'service-account', 'unknown'].includes(author.kind))
    throw new Error('Invalid author kind')
  return {
    displayName: author.displayName.trim(),
    kind: author.kind,
    ...(preserveIdentity &&
    author.source === 'google-drive' &&
    author.authenticatedPrincipal
      ? {
          source: 'google-drive' as const,
          authenticatedPrincipal: author.authenticatedPrincipal,
        }
      : {}),
  }
}

export function createReviewAnchor(
  reviewId: string,
  cellId?: string,
  quote?: string,
  diffTarget?: DiffCommentTarget
): string {
  return JSON.stringify({
    runme: {
      version: 1,
      type: 'review',
      reviewId,
      ...(cellId ? { cellId, quote } : {}),
      ...(diffTarget
        ? { cellId: diffTarget.cellId, quote: diffTarget.quote, diffTarget }
        : {}),
    },
  })
}

export function parseReviewAnchor(
  anchor?: string
): { reviewId: string; cellId?: string; quote?: string } | null {
  try {
    const value = JSON.parse(anchor ?? '').runme
    return value?.version === 1 &&
      value.type === 'review' &&
      typeof value.reviewId === 'string'
      ? value
      : null
  } catch {
    return null
  }
}

/** Exact committed IDs are a durable revision, not a timestamp or moving head. */
export function captureReviewRevision(operations: RunmeOperation[]): string[] {
  const committed = committedOperationIds(operations)
  return orderOperationSet(operations)
    .ordered.filter((op) => committed.has(op.op_id))
    .map((op) => op.op_id)
}

/** Project fixed comparisons and mutable discussion membership from the journal. */
export function buildReviewRounds(operations: RunmeOperation[]) {
  const committed = new Set(captureReviewRevision(operations))
  const ordered = orderOperationSet(operations).ordered.filter((op) =>
    committed.has(op.op_id)
  )
  const byId = new Map(ordered.map((op) => [op.op_id, op]))
  const reviewOperations = new Map<string, Set<string>>()
  const pairs = new Map<string, string>()
  const threadOperations = new Map<string, string>()
  const rounds = new Map<
    string,
    ReviewRoundRecord & {
      createdAt: string
      outcome?: ReviewOutcome
      summary?: string
      submittedAt?: string
      submittedBy?: Attribution
      threadIds: string[]
    }
  >()
  const snapshot = (ids: string[]) => {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length)
      throw new Error('Invalid review revision')
    const included = new Set(ids)
    for (const id of ids) {
      const op = byId.get(id)
      if (!op || op.deps.some((dep) => !included.has(dep)))
        throw new Error('Review revision is incomplete')
    }
    const subset = ordered.filter((op) => included.has(op.op_id))
    const subsetCommitted = committedOperationIds(subset)
    if (ids.some((id) => !subsetCommitted.has(id)))
      throw new Error('Review revision contains an uncommitted transaction')
    return materializedLogToNotebook(materializeOperationLog(subset))
  }
  for (const op of ordered) {
    const payload = op.payload as any
    if (op.kind === 'comment.add')
      threadOperations.set(payload.thread_id, op.op_id)
    if (!op.kind.startsWith('review.')) continue
    // A deterministic sort position is not evidence that a reference was seen
    // by its author. Require causal ancestry for every cross-record reference.
    const ancestors = new Set<string>()
    const pending = [...op.deps]
    while (pending.length) {
      const id = pending.pop()!
      if (ancestors.has(id)) continue
      ancestors.add(id)
      pending.push(...(byId.get(id)?.deps ?? []))
    }
    if (op.kind === 'review.create') {
      if (
        typeof payload.id !== 'string' ||
        !payload.id.trim() ||
        typeof payload.title !== 'string'
      )
        throw new Error('Invalid or duplicate review')
      for (const ids of [payload.baseOperationIds, payload.headOperationIds]) {
        snapshot(ids)
        if (ids.some((id: string) => !ancestors.has(id)))
          throw new Error('Review cannot reference future operations')
      }
      const head = new Set(payload.headOperationIds)
      if (payload.baseOperationIds.some((id: string) => !head.has(id)))
        throw new Error('Review base must be contained in its head')
      if (
        payload.previousReviewId &&
        ![...(reviewOperations.get(payload.previousReviewId) ?? [])].some(
          (id) => ancestors.has(id)
        )
      )
        throw new Error('Previous review not found')
      const cellIds = normalizeReviewCellIds(
        payload.cellIds,
        snapshot(payload.baseOperationIds),
        snapshot(payload.headOperationIds)
      )
      const pair = reviewIdentityKey(
        revisionKey(ordered, payload.baseOperationIds),
        revisionKey(ordered, payload.headOperationIds),
        cellIds
      )
      const sameId = rounds.get(payload.id)
      if (
        sameId &&
        reviewIdentityKey(
          revisionKey(ordered, sameId.baseOperationIds),
          revisionKey(ordered, sameId.headOperationIds),
          sameId.cellIds
        ) !== pair
      )
        throw new Error('Conflicting review ID')
      const existing = rounds.get(pairs.get(pair) ?? '')
      if (existing) {
        if (payload.id !== existing.id)
          existing.aliases = [
            ...new Set([...(existing.aliases ?? []), payload.id]),
          ]
        rounds.set(payload.id, existing)
      } else
        rounds.set(payload.id, {
          id: payload.id,
          title: payload.title,
          baseOperationIds: [...payload.baseOperationIds],
          headOperationIds: [...payload.headOperationIds],
          ...(cellIds ? { cellIds } : {}),
          ...(payload.previousReviewId
            ? { previousReviewId: payload.previousReviewId }
            : {}),
          author: normalizeAttribution(payload.author, true),
          createdAt: op.created_at,
          threadIds: [],
        })
      pairs.set(pair, existing?.id ?? payload.id)
      const creates = reviewOperations.get(payload.id) ?? new Set<string>()
      creates.add(op.op_id)
      reviewOperations.set(payload.id, creates)
    } else if (op.kind === 'review.submit') {
      const round = rounds.get(payload.reviewId)
      if (
        !round ||
        ![...(reviewOperations.get(payload.reviewId) ?? [])].some((id) =>
          ancestors.has(id)
        ) ||
        !REVIEW_OUTCOMES.includes(payload.outcome) ||
        (payload.summary !== undefined && typeof payload.summary !== 'string')
      )
        throw new Error('Invalid review submission')
      Object.assign(round, {
        outcome: payload.outcome,
        summary: payload.summary,
        submittedAt: op.created_at,
        submittedBy: normalizeAttribution(payload.author, true),
      })
    } else if (op.kind === 'review.link_thread') {
      const round = rounds.get(payload.reviewId)
      if (
        !round ||
        ![...(reviewOperations.get(payload.reviewId) ?? [])].some((id) =>
          ancestors.has(id)
        ) ||
        !ancestors.has(threadOperations.get(payload.commentId)!)
      )
        throw new Error('Review thread not found')
      if (!round.threadIds.includes(payload.commentId))
        round.threadIds.push(payload.commentId)
    }
  }
  return [...new Set(rounds.values())].map((round) => {
    const before = snapshot(round.baseOperationIds)
    const after = snapshot(round.headOperationIds)
    return {
      ...round,
      before,
      after,
      diff: computeReviewDiff(before, after, round.cellIds),
    }
  })
}

export type NotebookReviewRound = ReturnType<typeof buildReviewRounds>[number]
