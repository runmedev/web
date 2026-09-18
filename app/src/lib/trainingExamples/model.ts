import { canonicalJson } from '../operationLog/canonicalJson'
import { materializeOperationLog } from '../operationLog/materialize'
import { type NotebookRecord, type VersionRef } from '../operationLog/records'
import type { JsonValue, RunmeOperation } from '../operationLog/types'
import { resolveVersion } from '../operationLog/versions'

export const EXAMPLE_RULE_VERSION = 'cell-version-content-v3'

export type ExampleSource = { driveFileId: string } | { localUri: string }
export type LabelSource =
  | 'named-revision'
  | 'cell-decision'
  | 'comment'
  | 'synthetic-reverse'

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
  /** Self-contained, sanitized records. Never append these to the source log. */
  base: NotebookRecord[]
  diff: NotebookRecord[]
  accepted: boolean
  provenance: {
    source: ExampleSource
    labelSource: LabelSource
    recordIds: string[]
    cellIds: string[]
    start: VersionRef | null
    end: VersionRef
    derivedFrom?: string
  }
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
  example: { start: VersionRef; end: VersionRef }
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

export { extractExamples } from './extract'
