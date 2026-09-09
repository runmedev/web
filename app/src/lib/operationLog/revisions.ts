import md5 from 'md5'

import { materializeOperationLog } from './materialize'
import { materializedLogToNotebook } from './notebook'
import { committedOperationIds, orderOperationSet } from './order'
import { type VersionRef, changesNotebook } from './records'
import type { RunmeOperation } from './types'
import { ancestorClosure, resolveVersion } from './versions'

export { changesNotebook } from './records'

export interface NotebookRevision {
  id: string
  operationIds: string[]
  changeIds: string[]
  lastChangedAt?: string
  name?: string
  description?: string
  version?: VersionRef
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

/** Resolve a public reference without replacing its exact history with a picker alias. */
export function notebookRevisionForVersion(
  operations: RunmeOperation[],
  version: VersionRef
): NotebookRevision {
  const selected = resolveVersion(operations, version)
  const operationIds = selected.map((op) => op.op_id)
  return {
    id: version.kind === 'revision' ? version.revision_id : version.op_id,
    version,
    operationIds,
    changeIds: JSON.parse(revisionKey(selected, operationIds)),
    lastChangedAt: selected.filter(changesNotebook).at(-1)?.created_at,
  }
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
    const dates = changes
      .map((op) => op.created_at)
      .filter((date) => Number.isFinite(Date.parse(date)))
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
      const closure = ancestorClosure(ordered, [op.op_id])
      const committed = committedOperationIds(closure)
      const ids = closure.map((candidate) => candidate.op_id)
      // A dependent edit can precede its transaction commit in the total order.
      // Such an intermediate prefix is not a standalone revision.
      if (closure.some((candidate) => !committed.has(candidate.op_id))) continue
      const revision = add(ids)
      revision.version ??= { kind: 'operation', op_id: op.op_id }
    }
    const payload = op.payload as any
    if (op.kind === 'revision.checkpoint') {
      const subset = resolveVersion(ordered, {
        kind: 'revision',
        revision_id: op.op_id,
      })
      const revision = add(subset.map((op) => op.op_id))
      // Preserve old display IDs as aliases in callers, while native checkpoints
      // remain directly addressable by their actual causal record identity.
      const checkpoint = {
        ...revision,
        id: op.op_id,
        version: { kind: 'revision' as const, revision_id: op.op_id },
        name: payload.name,
        description: payload.description,
      }
      revisions.set(op.op_id, checkpoint)
    }
    if (op.kind === 'review.create') {
      add(payload.baseOperationIds)
      add(payload.headOperationIds)
    }
    if (op.kind === 'revision.label') {
      if (payload.revision?.kind === 'revision') {
        const revision = revisions.get(payload.revision.revision_id)
        if (!revision) throw new Error('Revision label target unavailable')
        revision.name = payload.name
        revision.description = payload.description
        continue
      }
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
  // A merged visible head can contain several concurrent causal branches. This
  // ephemeral picker entry becomes durable only when checkpointed by a writer.
  add(ordered.map((op) => op.op_id))
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
