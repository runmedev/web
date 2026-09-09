import { sourceAnchorsFromLegacy } from './anchorConversion'
import { parseOperationLog, serializeOperationLog } from './codec'
import { buildReviewRounds, normalizeAttribution } from './legacyReviews'
import { materializeOperationLog } from './materialize'
import {
  causalHeads,
  createRunmeOperation,
  highestActorSequence,
} from './mutations'
import { committedOperationIds, orderOperationSet } from './order'
import {
  type Anchor,
  type CommentRecord,
  type ComparisonContext,
  type RevisionRecord,
  type VersionRef,
  projectRecord,
} from './records'
import { buildNotebookRevisions } from './revisions'
import type { JsonValue } from './types'
import { ancestorClosure, snapshotHeads } from './versions'

/** Migration is a pure export to a NEW notebook identity. Original records stay
 * intact as provenance; only successfully mapped legacy comments are hidden by
 * the migration marker. Errors return a report instead of a lossy output file.
 */
export async function migrateOperationLogV2(
  document: string,
  notebookId: string
) {
  const parsed = parseOperationLog(document)
  if (parsed.header.format_version !== 1)
    throw new Error('Only V1 notebooks require migration')
  if (!notebookId || notebookId === parsed.header.notebook_id)
    throw new Error('Migration requires a new notebook identity')
  const original = parsed.operations
  const operations = [...original]
  const actorId = `migration_${notebookId}`
  const author = {
    displayName: 'V1 format migration',
    kind: 'service-account' as const,
  }
  const warnings: string[] = []
  const commentIds: Record<string, string> = {}
  const revisionIds: Record<string, VersionRef> = {}
  const checkpoints = new Map<string, VersionRef>()
  const envelope = () => {
    const {
      kind: _kind,
      payload: _payload,
      ...op
    } = createRunmeOperation({
      actorId,
      actorSequence: highestActorSequence(operations, actorId) + 1,
      dependencies: causalHeads(operations),
      knownOperations: operations,
      kind: 'entity',
      payload: {},
      createdAt: parsed.header.created_at,
    })
    return { ...op, format_version: 2 as const }
  }
  const checkpoint = (
    ids: string[],
    name?: string,
    description?: string
  ): VersionRef => {
    const heads = snapshotHeads(original, ids)
    const key = JSON.stringify([heads, name, description])
    const existing = checkpoints.get(key)
    if (existing) return existing
    const record: RevisionRecord = {
      ...envelope(),
      record_type: 'runme.revision',
      snapshot_heads: heads,
      author,
      ...(name ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    }
    operations.push(projectRecord(record))
    const ref: VersionRef = { kind: 'revision', revision_id: record.op_id }
    checkpoints.set(key, ref)
    return ref
  }
  const add = (
    value: Omit<
      CommentRecord,
      keyof ReturnType<typeof envelope> | 'record_type' | 'thread_id'
    > & { thread_id?: string; created_at?: string }
  ) => {
    const causal = envelope()
    const record: CommentRecord = {
      ...causal,
      ...value,
      record_type: 'runme.comment',
      thread_id: value.thread_id ?? causal.op_id,
    }
    operations.push(projectRecord(record))
    return record.op_id
  }
  const committed = committedOperationIds(original)
  if (committed.size !== original.length)
    return {
      warnings: ['Complete pending operations/transactions before migration.'],
    }
  const rounds = buildReviewRounds(original)
  const contexts = new Map<string, ComparisonContext>()
  for (const round of rounds) {
    const context = {
      start: checkpoint(round.baseOperationIds),
      end: checkpoint(round.headOperationIds),
      ...(round.cellIds ? { cell_ids: round.cellIds } : {}),
    }
    for (const id of [round.id, ...(round.aliases ?? [])])
      contexts.set(id, context)
  }
  for (const revision of buildNotebookRevisions(original).filter((r) => r.name))
    revisionIds[revision.id] = checkpoint(
      revision.operationIds,
      revision.name,
      revision.description
    )
  const originalById = new Map(original.map((op) => [op.op_id, op]))
  const materialized = materializeOperationLog(original)
  for (const comment of materialized.comments) {
    const op = originalById.get(comment.operation_id)!
    const p = comment.payload
    const attribution = normalizeAttribution(
      {
        displayName: p.author.display_name,
        kind: p.author.kind ?? 'unknown',
        source: p.author.source,
        authenticatedPrincipal: p.author.authenticated_principal,
      },
      true
    )
    try {
      if (comment.parent_comment_id) {
        const parent = commentIds[comment.parent_comment_id],
          root = commentIds[comment.thread_id]
        if (!parent || !root)
          throw new Error('Parent comment could not be migrated')
        commentIds[comment.comment_id] = add({
          parent_comment_id: parent,
          thread_id: root,
          created_at: op.created_at,
          author: attribution,
          body: p.body,
        })
        continue
      }
      const raw = (p.annotation.targets[0] as any)?.anchor
      const target = raw ? JSON.parse(raw).runme : undefined
      if (!target) throw new Error('No supported anchor')
      const linked = rounds.filter((r) =>
        r.threadIds.includes(comment.comment_id)
      )
      if (linked.length > 1)
        throw new Error(
          'Thread linked to multiple comparisons; requires explicit multi-context migration'
        )
      const comparison = contexts.get(target.reviewId ?? linked[0]?.id)
      const version = comparison
        ? target.diffTarget?.side === 'base'
          ? comparison.start
          : comparison.end
        : checkpoint(ancestorClosure(original, op.deps).map((op) => op.op_id))
      let anchors: Anchor[]
      if (target.cellId) {
        anchors = await sourceAnchorsFromLegacy(operations, target, version)
      } else if (comparison)
        anchors = [
          { kind: 'notebook', version: comparison.start },
          { kind: 'notebook', version: comparison.end },
        ]
      else
        throw new Error(
          'Legacy comment has no addressable notebook/cell version'
        )
      commentIds[comment.comment_id] = add({
        created_at: op.created_at,
        author: attribution,
        body: p.body,
        anchors,
        ...(comparison ? { comparison } : {}),
      })
    } catch (error) {
      warnings.push(`Comment ${comment.comment_id}: ${String(error)}`)
    }
  }
  // Preserve every legacy assessment, not just its latest UI projection.
  for (const op of orderOperationSet(original).ordered) {
    const p = op.payload as any
    if (!['review.submit', 'review.cell_decision'].includes(op.kind)) continue
    const comparison = contexts.get(p.reviewId)
    if (!comparison) {
      warnings.push(`Assessment ${op.op_id}: comparison unavailable`)
      continue
    }
    const body =
      p.summary || (op.kind === 'review.cell_decision' ? p.decision : p.outcome)
    add({
      created_at: op.created_at,
      author: normalizeAttribution(p.author),
      body: { format: 'text/markdown', value: body },
      comparison,
      anchors: [
        { kind: 'notebook', version: comparison.start },
        { kind: 'notebook', version: comparison.end },
      ],
      ...(op.kind === 'review.cell_decision'
        ? {
            assessment: {
              kind: 'cell' as const,
              cell_id: p.cellId,
              decision: p.decision,
            },
          }
        : p.outcome === 'comment'
          ? {}
          : {
              assessment: {
                kind: 'scope' as const,
                outcome: ['approve', 'good_enough'].includes(p.outcome)
                  ? ('good_enough' as const)
                  : ('needs_more_work' as const),
              },
            }),
    })
  }
  if (warnings.length) return { warnings }
  for (const [oldId, newId] of Object.entries(commentIds)) {
    if (materialized.threadStatus[oldId] !== 'resolved') continue
    operations.push(
      createRunmeOperation({
        actorId,
        actorSequence: highestActorSequence(operations, actorId) + 1,
        dependencies: causalHeads(operations),
        knownOperations: operations,
        kind: 'thread.set_status',
        payload: { thread_id: newId, status: 'resolved' },
        createdAt: parsed.header.created_at,
      })
    )
  }
  operations.push(
    createRunmeOperation({
      actorId,
      actorSequence: highestActorSequence(operations, actorId) + 1,
      dependencies: causalHeads(operations),
      knownOperations: operations,
      kind: 'migration.v2',
      payload: {
        source_notebook_id: parsed.header.notebook_id,
        comment_ids: commentIds,
        revision_ids: revisionIds as unknown as JsonValue,
      },
      createdAt: parsed.header.created_at,
    })
  )
  const output = serializeOperationLog(
    { ...parsed.header, format_version: 2, notebook_id: notebookId },
    operations
  )
  if (
    JSON.stringify(
      materializeOperationLog(parseOperationLog(output).operations).notebook
    ) !== JSON.stringify(materialized.notebook)
  )
    return {
      warnings: [
        'Migration changed the notebook snapshot; no copy was created.',
      ],
    }
  return { document: output, warnings, commentIds, revisionIds }
}
