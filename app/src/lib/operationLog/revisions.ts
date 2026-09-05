import md5 from 'md5'

import { materializeOperationLog } from './materialize'
import { materializedLogToNotebook } from './notebook'
import { committedOperationIds, orderOperationSet } from './order'
import type { RunmeOperation } from './types'

export interface NotebookRevision {
  id: string
  operationIds: string[]
  changeIds: string[]
  lastChangedAt?: string
  name?: string
  description?: string
}

/** Review/comment/label operations must not create new notebook versions. */
export function changesNotebook(op: RunmeOperation): boolean {
  return (
    /^(cell\.|notebook\.|execution\.)/.test(op.kind) ||
    op.kind === 'suggestion.review'
  )
}

/** Compare full change sets, not labels, timestamps, or their display hashes. */
export function revisionKey(
  operations: RunmeOperation[],
  ids: string[]
): string {
  const included = new Set(ids)
  return JSON.stringify(
    operations
      .filter((op) => included.has(op.op_id) && changesNotebook(op))
      .map((op) => op.op_id)
      .sort()
  )
}

/** Validate exact, causally closed, fully committed snapshots before replay. */
export function revisionOperations(
  operations: RunmeOperation[],
  ids: string[]
): RunmeOperation[] {
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length)
    throw new Error('Invalid revision operations')
  const included = new Set(ids)
  const ordered = orderOperationSet(operations).ordered.filter((op) =>
    included.has(op.op_id)
  )
  if (
    ordered.length !== ids.length ||
    ordered.some((op) => op.deps.some((dep) => !included.has(dep)))
  )
    throw new Error('Revision is incomplete')
  const committed = committedOperationIds(ordered)
  if (ids.some((id) => !committed.has(id)))
    throw new Error('Revision has an uncommitted transaction')
  return ordered
}

/** Replay on demand: the picker only needs summaries, not every notebook clone. */
export function materializeRevision(
  operations: RunmeOperation[],
  ids: string[]
) {
  return materializedLogToNotebook(
    materializeOperationLog(revisionOperations(operations, ids))
  )
}

/** Later means a strict extension of the start's changes, not wall-clock order. */
export function revisionFollows(
  start: NotebookRevision,
  end: NotebookRevision
): boolean {
  const head = new Set(end.changeIds)
  return (
    head.size > start.changeIds.length &&
    start.changeIds.every((id) => head.has(id))
  )
}

/** Each committed edit/save is selectable. Named and reviewed snapshots remain
 * addressable even if merging a concurrent branch changes the linear history.
 */
export function buildNotebookRevisions(
  operations: RunmeOperation[]
): NotebookRevision[] {
  const allCommitted = committedOperationIds(operations)
  const ordered = orderOperationSet(operations).ordered.filter((op) =>
    allCommitted.has(op.op_id)
  )
  const revisions = new Map<string, NotebookRevision>()
  const add = (ids: string[]) => {
    const subset = revisionOperations(ordered, ids)
    const key = revisionKey(subset, ids)
    const id = key === '[]' ? 'empty' : `revision:${md5(key)}`
    const existing = revisions.get(id)
    if (existing) {
      if (JSON.stringify(existing.changeIds) !== key)
        throw new Error('Revision ID collision')
      return existing
    }
    const changes = subset.filter(changesNotebook)
    const transactions = new Set(
      changes.map((op) => op.transaction_id).filter(Boolean)
    )
    const dates = subset
      .filter(
        (op) =>
          changesNotebook(op) ||
          (op.kind === 'transaction.commit' &&
            transactions.has((op.payload as any).transaction_id))
      )
      .map((op) => op.created_at)
      .filter((date) => Number.isFinite(Date.parse(date)))
      .sort()
    const revision: NotebookRevision = {
      id,
      operationIds: [...ids],
      changeIds: JSON.parse(key),
      lastChangedAt: dates.at(-1),
    }
    revisions.set(id, revision)
    return revision
  }
  add([])
  const prefix: RunmeOperation[] = []
  for (const op of ordered) {
    prefix.push(op)
    if (
      (changesNotebook(op) && !op.transaction_id) ||
      op.kind === 'transaction.commit'
    ) {
      const committed = committedOperationIds(prefix)
      const ids = prefix
        .filter((candidate) => committed.has(candidate.op_id))
        .map((candidate) => candidate.op_id)
      // A dependent edit can precede its transaction commit in the total order.
      // Such an intermediate prefix is not a standalone revision.
      if (
        prefix.some(
          (candidate) =>
            committed.has(candidate.op_id) &&
            candidate.deps.some((dep) => !committed.has(dep))
        )
      )
        continue
      add(ids)
    }
    const payload = op.payload as any
    if (op.kind === 'review.create') {
      add(payload.baseOperationIds)
      add(payload.headOperationIds)
    }
    if (op.kind === 'revision.label') {
      if (
        typeof payload.name !== 'string' ||
        !payload.name.trim() ||
        typeof payload.description !== 'string'
      )
        throw new Error('Invalid revision label')
      const ancestors = new Set<string>()
      const byId = new Map(
        prefix.map((candidate) => [candidate.op_id, candidate])
      )
      const pending = [...op.deps]
      while (pending.length) {
        const id = pending.pop()!
        if (ancestors.has(id)) continue
        ancestors.add(id)
        pending.push(...(byId.get(id)?.deps ?? []))
      }
      if (
        !Array.isArray(payload.operationIds) ||
        payload.operationIds.some((id: string) => !ancestors.has(id))
      )
        throw new Error('Revision label references unseen operations')
      const revision = add(payload.operationIds)
      if (payload.revisionId !== revision.id)
        throw new Error('Revision label ID mismatch')
      revision.name = payload.name.trim()
      revision.description = payload.description
    }
  }
  return [...revisions.values()].sort(
    (a, b) =>
      a.changeIds.length - b.changeIds.length || a.id.localeCompare(b.id)
  )
}

/** Use the user's time zone (including DST) rather than hard-coding PST. */
export function revisionLabel(revision: NotebookRevision): string {
  const date = revision.lastChangedAt
    ? new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(revision.lastChangedAt))
    : 'Before first change'
  return [
    revision.name ||
      (revision.id === 'empty'
        ? 'Empty notebook'
        : `Version ${revision.changeIds.length}`),
    revision.description,
    date,
  ]
    .filter(Boolean)
    .join(' — ')
}
