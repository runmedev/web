import md5 from 'md5'

import { committedOperationIds, orderOperationSet } from '../operationLog/order'
import {
  type CommentRecord,
  type VersionRef,
  serializedRecord,
} from '../operationLog/records'
import {
  buildNotebookRevisions,
  notebookRevisionForVersion,
  revisionFollows,
  revisionKey,
} from '../operationLog/revisions'
import type { RunmeOperation } from '../operationLog/types'
import { resolveVersion } from '../operationLog/versions'
import {
  EXAMPLE_RULE_VERSION,
  type ExampleCell,
  type ExampleEdit,
  type ExampleSource,
  type ExtractedExamples,
  type LabelSource,
  type TrainingExample,
  applyExampleEdits,
  exampleJson,
  exampleSnapshot,
} from './model'
import { planContentExample } from './payloads'
import { contentRecords } from './recordInput'

interface Candidate {
  cellId: string
  end: VersionRef
  accepted: boolean
  labelSource: LabelSource
  recordIds: string[]
}

/** Express a scoped transition using only operations on its labeled cell.
 * A generic reorder diff may instead move neighboring, unassessed cells.
 */
function cellEdits(
  before: ExampleCell[],
  after: ExampleCell[],
  cellId: string
): ExampleEdit[] {
  const previous = before.find((c) => c.cell === cellId)
  const next = after.find((c) => c.cell === cellId)
  const position = after.findIndex((c) => c.cell === cellId)
  const anchor = position > 0 ? after[position - 1].cell : null
  const edits: ExampleEdit[] = []
  const content = (c: ExampleCell) => ({
    kind: c.kind,
    language: c.language,
    value: c.value,
  })
  if (previous && !next) edits.push({ kind: 'delete', cell: cellId })
  else if (!previous && next)
    edits.push({
      kind: 'insert',
      cell: cellId,
      after: anchor,
      content: content(next),
    })
  else if (previous && next) {
    if (before.findIndex((c) => c.cell === cellId) !== position)
      edits.push({ kind: 'move', cell: cellId, after: anchor })
    if (exampleJson(content(previous)) !== exampleJson(content(next)))
      edits.push({ kind: 'update', cell: cellId, content: content(next) })
  }
  if (exampleJson(applyExampleEdits(before, edits)) !== exampleJson(after))
    throw new Error('Scoped cell replay mismatch')
  return edits
}

/** Read explicit evidence and infer labels for cell versions. Causal ancestry,
 * not JSONL order or wall-clock time, chooses the preceding named baseline.
 */
export function extractExamples(
  operations: RunmeOperation[],
  notebookId: string,
  options: { syntheticReverse?: boolean; sources?: LabelSource[] } = {}
): ExtractedExamples {
  const issues: ExtractedExamples['issues'] = []
  const examples: TrainingExample[] = []
  const source: ExampleSource = notebookId.startsWith('local://')
    ? { localUri: notebookId }
    : { driveFileId: notebookId }
  const committed = committedOperationIds(operations)
  const ordered = orderOperationSet(operations).ordered.filter((op) =>
    committed.has(op.op_id)
  )
  const groups = new Map<
    string,
    ReturnType<typeof buildNotebookRevisions>[number]
  >()
  for (const revision of buildNotebookRevisions(ordered)
    .filter((r) => r.name?.trim() && r.version)
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const key = revisionKey(ordered, revision.operationIds)
    if (!groups.has(key)) groups.set(key, revision)
  }
  const named = [...groups.values()]
  const snapshots = new Map<string, ExampleCell[]>()
  const versionOperations = new Map<string, RunmeOperation[]>()
  const resolve = (v: VersionRef) => {
    const key = exampleJson(v)
    if (!versionOperations.has(key))
      versionOperations.set(key, resolveVersion(ordered, v))
    return versionOperations.get(key)!
  }
  const snapshot = (v: VersionRef): ExampleCell[] => {
    const key = exampleJson(v)
    if (!snapshots.has(key)) snapshots.set(key, exampleSnapshot(ordered, v))
    return snapshots.get(key)!
  }
  const predecessors = (end: VersionRef) => {
    const target = notebookRevisionForVersion(ordered, end)
    const earlier = named.filter((r) => revisionFollows(r, target))
    return earlier.filter(
      (r) => !earlier.some((other) => revisionFollows(r, other))
    )
  }
  // A version persists through unrelated cell edits. Key evidence by the last
  // cell mutation, not the enclosing notebook version or its checkpoint alias.
  const cellVersion = (v: VersionRef, cellId: string) => {
    const mutation = resolve(v)
      .filter(
        (op) =>
          [
            'cell.create',
            'cell.update',
            'cell.delete',
            'cell.restore',
            'cell.move',
          ].includes(op.kind) &&
          (op.payload as { cell_id?: string }).cell_id === cellId
      )
      .at(-1)
    return mutation?.op_id ?? 'absent'
  }
  const evidence = new Map<string, Candidate[]>()
  const add = (candidate: Candidate) => {
    const key = exampleJson([
      candidate.cellId,
      cellVersion(candidate.end, candidate.cellId),
    ])
    evidence.set(key, [...(evidence.get(key) ?? []), candidate])
  }
  for (const revision of named) {
    const end = revision.version!
    const prior = predecessors(end)
    // Include deletions, which have no cell in the end snapshot.
    const ids = new Set(snapshot(end).map((c) => c.cell))
    for (const start of prior)
      for (const cell of snapshot(start.version!)) ids.add(cell.cell)
    for (const cellId of ids)
      add({
        cellId,
        end,
        accepted: true,
        labelSource: 'named-revision',
        recordIds: [revision.id],
      })
  }
  const roots = new Map<string, CommentRecord>()
  for (const op of ordered) {
    if (op.kind !== 'comment.record') continue
    const record = serializedRecord(op) as CommentRecord
    if (!record.parent_comment_id) roots.set(record.thread_id, record)
    const root = roots.get(record.thread_id)
    const comparison = record.comparison ?? root?.comparison
    if (record.assessment?.kind === 'cell' && comparison) {
      add({
        cellId: record.assessment.cell_id,
        end: comparison.end,
        accepted: record.assessment.decision === 'accept',
        labelSource: 'cell-decision',
        recordIds: [record.op_id],
      })
    } else if (!record.assessment && record.body.value.trim()) {
      for (const anchor of record.anchors ?? root?.anchors ?? []) {
        if (anchor.kind !== 'cell') continue
        add({
          cellId: anchor.cell_id,
          end: anchor.version,
          accepted: false,
          labelSource: 'comment',
          recordIds: [record.op_id],
        })
      }
    }
  }
  const priority: Record<LabelSource, number> = {
    'cell-decision': 3,
    'named-revision': 2,
    comment: 1,
    'synthetic-reverse': 0,
  }
  for (const candidates of evidence.values()) {
    const rank = Math.max(...candidates.map((c) => priority[c.labelSource]))
    const selected = candidates.filter((c) => priority[c.labelSource] === rank)
    if (options.sources && !options.sources.includes(selected[0].labelSource))
      continue
    if (new Set(selected.map((c) => c.accepted)).size > 1) {
      issues.push({
        recordIds: selected.flatMap((c) => c.recordIds),
        reason: 'Conflicting explicit labels for one cell version; deferred',
      })
      continue
    }
    // The same cell version can occur in many named snapshots. Consider its
    // earliest causal occurrence first, avoiding duplicate positives.
    selected.sort((a, b) => {
      const av = notebookRevisionForVersion(ordered, a.end),
        bv = notebookRevisionForVersion(ordered, b.end)
      if (revisionFollows(av, bv)) return -1
      if (revisionFollows(bv, av)) return 1
      return exampleJson(a.end).localeCompare(exampleJson(b.end))
    })
    for (const candidate of selected) {
      const nearest = predecessors(candidate.end)
      if (nearest.length > 1) {
        issues.push({
          recordIds: candidate.recordIds,
          reason:
            'Multiple incomparable named predecessors; cell example deferred',
        })
        break
      }
      const start = nearest[0]?.version ?? null
      const before = start ? snapshot(start) : []
      const endCells = snapshot(candidate.end)
      const targetCell = endCells.find((c) => c.cell === candidate.cellId)
      // Change only the assessed cell. Unselected cells stay at the baseline.
      const after = before.filter((c) => c.cell !== candidate.cellId)
      if (targetCell) {
        const endIndex = endCells.indexOf(targetCell)
        const predecessor = endCells
          .slice(0, endIndex)
          .reverse()
          .find((c) => after.some((b) => b.cell === c.cell))
        const at = predecessor
          ? after.findIndex((c) => c.cell === predecessor.cell) + 1
          : 0
        after.splice(at, 0, targetCell)
      }
      // Pure content updates must not move the cell because an unrelated cell
      // was reordered. Preserve its baseline position unless this cell moved.
      const previous = before.findIndex((c) => c.cell === candidate.cellId)
      const baseIds = new Set(start ? resolve(start).map((op) => op.op_id) : [])
      const moved = resolve(candidate.end).some(
        (op) =>
          op.kind === 'cell.move' &&
          (op.payload as { cell_id?: string }).cell_id === candidate.cellId &&
          !baseIds.has(op.op_id)
      )
      if (previous >= 0 && targetCell && !moved) {
        after.splice(
          after.findIndex((c) => c.cell === candidate.cellId),
          1
        )
        after.splice(previous, 0, targetCell)
      }
      const ids = new Map<string, string>()
      for (const cell of [...before, ...after])
        if (!ids.has(cell.cell)) ids.set(cell.cell, `cell-${ids.size + 1}`)
      const normalize = (cells: ExampleCell[]) =>
        cells.map((c) => ({ ...c, cell: ids.get(c.cell)! }))
      const initial = normalize(before),
        final = normalize(after)
      const edits = cellEdits(initial, final, ids.get(candidate.cellId)!)
      if (!edits.length) continue
      const records = contentRecords(
        planContentExample({ initial, operations: edits })
      )
      const provenance: TrainingExample['provenance'] = {
        source,
        labelSource: candidate.labelSource,
        recordIds: [...new Set(selected.flatMap((c) => c.recordIds))].sort(),
        cellIds: [candidate.cellId],
        start,
        end: candidate.end,
      }
      const id = md5(
        exampleJson([
          EXAMPLE_RULE_VERSION,
          notebookId,
          provenance,
          records,
          candidate.accepted,
        ])
      )
      examples.push({
        id,
        ...records,
        accepted: candidate.accepted,
        provenance,
      })
      // Synthetic reversal is opt-in compatibility, never an automatic label.
      if (options.syntheticReverse && candidate.accepted) {
        const reverse = contentRecords(
          planContentExample({
            initial: final,
            operations: cellEdits(final, initial, ids.get(candidate.cellId)!),
          })
        )
        examples.push({
          id: md5(exampleJson([id, 'reverse'])),
          ...reverse,
          accepted: false,
          provenance: {
            ...provenance,
            labelSource: 'synthetic-reverse',
            derivedFrom: id,
          },
        })
      }
      break
    }
  }
  return { examples: examples.sort((a, b) => a.id.localeCompare(b.id)), issues }
}
