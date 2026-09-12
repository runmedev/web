import md5 from 'md5'

import { canonicalJson } from '../operationLog/canonicalJson'
import { materializeOperationLog } from '../operationLog/materialize'
import { committedOperationIds, orderOperationSet } from '../operationLog/order'
import {
  type CommentRecord,
  type VersionRef,
  serializedRecord,
} from '../operationLog/records'
import {
  buildNotebookRevisions,
  revisionFollows,
  revisionKey,
} from '../operationLog/revisions'
import type { JsonValue, RunmeOperation } from '../operationLog/types'
import { resolveVersion } from '../operationLog/versions'

export const EXAMPLE_RULE_VERSION = 'revision-pair-content-v1'

export interface ExampleContent {
  kind: 'code' | 'markup'
  language: string
  value: string
}
export interface ExampleCell extends ExampleContent {
  cell: string
}
export type ExampleEdit =
  | { kind: 'delete'; cell: string }
  | {
      kind: 'insert'
      cell: string
      after: string | null
      content: ExampleContent
    }
  | { kind: 'update'; cell: string; content: ExampleContent }
  | { kind: 'move'; cell: string; after: string | null }

export interface TrainingExample {
  id: string
  start: VersionRef
  end: VersionRef
  accepted: boolean
  provenance: {
    source: 'named-revision' | 'cell-decision' | 'synthetic-reverse'
    recordIds: string[]
    derivedFrom?: string
  }
}
export interface ExampleSource {
  notebookId: string
  driveFileId?: string
  localUri: string
}
export interface ExamplesHeader {
  record_type: 'runme.examples'
  format_version: 1
  source: ExampleSource
  ruleVersion: string
  sourceChecksum: string
}
export interface ExampleIssue {
  recordIds: string[]
  reason: string
}
export interface ExtractedExamples {
  examples: TrainingExample[]
  issues: ExampleIssue[]
}
export interface ClassifierInput {
  initial: ExampleCell[]
  operations: ExampleEdit[]
}

/** Stable encoding for derived identities; never used as classifier features. */
export function exampleJson(value: unknown): string {
  return canonicalJson(value as JsonValue)
}

/** Whitelist content instead of trying to blacklist all future metadata fields. */
function content(cell: ExampleContent): ExampleContent {
  return { kind: cell.kind, language: cell.language, value: cell.value }
}

/** S(V) keeps exact source text and order, but no comments, outputs or authors. */
export function exampleSnapshot(
  operations: RunmeOperation[],
  version: VersionRef
): ExampleCell[] {
  const log = materializeOperationLog(resolveVersion(operations, version))
  if (log.pendingOperationIds.length || log.unknownOperationIds.length)
    throw new Error(
      'Cannot extract examples from incomplete or unsupported history'
    )
  return log.notebook.cells.map((cell) => ({
    cell: cell.cell_id,
    kind: cell.kind,
    language: cell.language_id,
    value: cell.value,
  }))
}

/** Replay is isolated and strict. A stale/missing anchor never means append. */
export function applyExampleEdits(
  initial: ExampleCell[],
  edits: ExampleEdit[]
): ExampleCell[] {
  const result = initial.map((cell) => ({ cell: cell.cell, ...content(cell) }))
  if (new Set(result.map((cell) => cell.cell)).size !== result.length)
    throw new Error('Duplicate example cell identity')
  for (const edit of edits) {
    const index = result.findIndex((cell) => cell.cell === edit.cell)
    if (edit.kind === 'insert' ? index >= 0 : index < 0)
      throw new Error(`Invalid ${edit.kind} target: ${edit.cell}`)
    if (edit.kind === 'delete') {
      result.splice(index, 1)
      continue
    }
    if (edit.kind === 'update') {
      result[index] = { cell: edit.cell, ...content(edit.content) }
      continue
    }
    if (edit.after === edit.cell) throw new Error('A cell cannot follow itself')
    const value =
      edit.kind === 'move'
        ? result.splice(index, 1)[0]
        : { cell: edit.cell, ...content(edit.content) }
    const anchor =
      edit.after === null
        ? -1
        : result.findIndex((cell) => cell.cell === edit.after)
    if (edit.after !== null && anchor < 0)
      throw new Error('Example insertion anchor is absent')
    result.splice(anchor + 1, 0, value)
  }
  return result
}

/** C(Vi,Vj) emits net cell edits, not a minimum character patch or CRDT inverse. */
export function compressSnapshots(
  before: ExampleCell[],
  after: ExampleCell[]
): ExampleEdit[] {
  if (new Set(after.map((cell) => cell.cell)).size !== after.length)
    throw new Error('Duplicate target cell identity')
  let current = applyExampleEdits(before, [])
  const targetIds = new Set(after.map((cell) => cell.cell))
  const edits: ExampleEdit[] = []
  const emit = (edit: ExampleEdit) => {
    current = applyExampleEdits(current, [edit])
    edits.push(edit)
  }
  for (const cell of before)
    if (!targetIds.has(cell.cell)) emit({ kind: 'delete', cell: cell.cell })
  for (const [index, cell] of after.entries()) {
    const anchor = index ? after[index - 1].cell : null
    const existing = current.find((candidate) => candidate.cell === cell.cell)
    if (!existing)
      emit({
        kind: 'insert',
        cell: cell.cell,
        after: anchor,
        content: content(cell),
      })
    else {
      if (current[index]?.cell !== cell.cell)
        emit({ kind: 'move', cell: cell.cell, after: anchor })
      if (exampleJson(content(existing)) !== exampleJson(content(cell)))
        emit({ kind: 'update', cell: cell.cell, content: content(cell) })
    }
  }
  if (exampleJson(current) !== exampleJson(after))
    throw new Error('Example replay mismatch')
  return edits
}

/** Mask opaque cell IDs consistently across both endpoints of a single example. */
export function prepareExample(
  operations: RunmeOperation[],
  example: Pick<TrainingExample, 'start' | 'end'>
): ClassifierInput {
  const before = exampleSnapshot(operations, example.start)
  const after = exampleSnapshot(operations, example.end)
  const ids = new Map<string, string>()
  for (const cell of [...before, ...after])
    if (!ids.has(cell.cell)) ids.set(cell.cell, `cell-${ids.size + 1}`)
  const normalize = (cells: ExampleCell[]) =>
    cells.map((cell) => ({ ...content(cell), cell: ids.get(cell.cell)! }))
  const initial = normalize(before)
  return { initial, operations: compressSnapshots(initial, normalize(after)) }
}

/** Rebuild the derived index. Historical naming repartitions adjacent pairs;
 * it must not append obsolete partitions to the dataset forever.
 */
export function extractExamples(
  operations: RunmeOperation[],
  notebookId: string,
  options: { syntheticReverse?: boolean } = {}
): ExtractedExamples {
  const examples: TrainingExample[] = [],
    issues: ExampleIssue[] = []
  const snapshots = new Map<string, ExampleCell[]>()
  const snapshot = (version: VersionRef) => {
    const key = exampleJson(version)
    if (!snapshots.has(key))
      snapshots.set(key, exampleSnapshot(operations, version))
    return snapshots.get(key)!
  }
  const add = (
    start: VersionRef,
    end: VersionRef,
    accepted: boolean,
    provenance: TrainingExample['provenance']
  ) => {
    const edits = compressSnapshots(snapshot(start), snapshot(end))
    if (!edits.length) return
    const value = { start, end, accepted, provenance }
    const id = md5(exampleJson([EXAMPLE_RULE_VERSION, notebookId, value]))
    if (!examples.some((example) => example.id === id))
      examples.push({ id, ...value })
  }
  // Group equivalent content histories; distinct checkpoint aliases do not
  // create additional examples. Native VersionRefs remain the stored identity.
  const groups = new Map<
    string,
    ReturnType<typeof buildNotebookRevisions>[number]
  >()
  for (const revision of buildNotebookRevisions(operations)
    .filter((r) => r.name?.trim() && r.version)
    .sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const key = revisionKey(operations, revision.operationIds)
    if (!groups.has(key)) groups.set(key, revision)
  }
  const named = [...groups.values()]
  for (const end of named) {
    const ancestors = named.filter((start) => revisionFollows(start, end))
    const nearest = ancestors.filter(
      (start) => !ancestors.some((other) => revisionFollows(start, other))
    )
    if (nearest.length > 1) {
      issues.push({
        recordIds: [end.id],
        reason: 'Multiple incomparable named predecessors; pair deferred',
      })
    } else if (nearest.length === 1) {
      const start = nearest[0]
      add(start.version!, end.version!, true, {
        source: 'named-revision',
        recordIds: [start.id, end.id],
      })
    }
  }
  const committed = committedOperationIds(operations)
  const roots = new Map<string, CommentRecord>()
  for (const op of orderOperationSet(operations).ordered) {
    if (!committed.has(op.op_id) || op.kind !== 'comment.record') continue
    const record = serializedRecord(op) as CommentRecord
    if (!record.parent_comment_id) roots.set(record.thread_id, record)
    const comparison =
      record.comparison ?? roots.get(record.thread_id)?.comparison
    if (!comparison || record.assessment?.kind !== 'cell') continue
    const assessedCell = record.assessment.cell_id
    const { start, end } = comparison
    const edits = compressSnapshots(snapshot(start), snapshot(end))
    if (edits.some((edit) => edit.cell !== assessedCell)) {
      issues.push({
        recordIds: [record.op_id],
        reason:
          'Cell decision covers only part of the endpoint delta; deferred',
      })
      continue
    }
    add(start, end, record.assessment.decision === 'accept', {
      source: 'cell-decision',
      recordIds: [record.op_id],
    })
  }
  if (options.syntheticReverse) {
    for (const example of [...examples].filter(
      (candidate) => candidate.accepted
    ))
      add(example.end, example.start, false, {
        source: 'synthetic-reverse',
        recordIds: example.provenance.recordIds,
        derivedFrom: example.id,
      })
  }
  const labels = new Map<string, TrainingExample[]>()
  for (const example of examples) {
    const key = exampleJson([snapshot(example.start), snapshot(example.end)])
    labels.set(key, [...(labels.get(key) ?? []), example])
  }
  for (const group of labels.values())
    if (new Set(group.map((example) => example.accepted)).size > 1)
      issues.push({
        recordIds: group.map((example) => example.id),
        reason: 'Conflicting labels for the same content transition',
      })
  return { examples: examples.sort((a, b) => (a.id < b.id ? -1 : 1)), issues }
}

/** The sidecar stores references only; features are reconstructed on demand. */
export function serializeExamples(
  header: ExamplesHeader,
  examples: TrainingExample[]
): string {
  return [header, ...examples].map(exampleJson).join('\n') + '\n'
}
