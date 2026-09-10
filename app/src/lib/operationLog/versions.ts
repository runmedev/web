import { committedOperationIds, operationMap, orderOperationSet } from './order'
import type {
  Anchor,
  CommentRecord,
  RevisionRecord,
  VersionRef,
} from './records'
import { changesNotebook, serializedRecord } from './records'
import type { RunmeOperation } from './types'

/** The current merged committed snapshot, used only as a transient projection. */
export function captureCommittedRevision(
  operations: RunmeOperation[]
): string[] {
  const committed = committedOperationIds(operations)
  return orderOperationSet(operations)
    .ordered.filter((op) => committed.has(op.op_id))
    .map((op) => op.op_id)
}

/** Recover an exact causal snapshot. A sorted-file prefix is never a version. */
export function ancestorClosure(
  operations: RunmeOperation[],
  heads: string[]
): RunmeOperation[] {
  const byId = operationMap(operations)
  const ids = new Set<string>()
  const pending = [...heads]
  while (pending.length) {
    const id = pending.pop()!
    if (ids.has(id)) continue
    const op = byId.get(id)
    if (!op) throw new Error(`Snapshot unavailable: missing operation ${id}`)
    ids.add(id)
    pending.push(...op.deps)
  }
  return orderOperationSet([...ids].map((id) => byId.get(id)!)).ordered
}

/** Minimize an already validated snapshot, including transaction commits. */
export function snapshotHeads(
  operations: RunmeOperation[],
  ids: string[]
): string[] {
  const selected = new Set(ids)
  if (selected.size !== ids.length)
    throw new Error('Duplicate snapshot operation')
  const subset = operations.filter((op) => selected.has(op.op_id))
  if (
    subset.length !== ids.length ||
    subset.some((op) => op.deps.some((id) => !selected.has(id)))
  )
    throw new Error('Snapshot is not causally closed')
  const committed = committedOperationIds(subset)
  if (subset.some((op) => !committed.has(op.op_id)))
    throw new Error('Snapshot contains an incomplete transaction')
  const ancestors = new Set(subset.flatMap((op) => op.deps))
  return ids.filter((id) => !ancestors.has(id)).sort()
}

/** A checkpoint's snapshot_heads are deliberately distinct from its own deps. */
export function resolveVersion(
  operations: RunmeOperation[],
  ref: VersionRef
): RunmeOperation[] {
  const id = ref.kind === 'operation' ? ref.op_id : ref.revision_id
  const op = operations.find((op) => op.op_id === id)
  if (!op) throw new Error(`Version unavailable: ${id}`)
  const ancestors = ancestorClosure(operations, [id])
  const committed = committedOperationIds(ancestors)
  if (ancestors.some((op) => !committed.has(op.op_id)))
    throw new Error('Version contains an incomplete transaction')
  if (ref.kind === 'operation') return ancestors
  if (op.kind !== 'revision.checkpoint')
    throw new Error('Version is not a revision record')
  const record = serializedRecord(op) as RevisionRecord
  const past = new Set(ancestors.map((op) => op.op_id))
  if (record.snapshot_heads.some((head) => head === id || !past.has(head)))
    throw new Error('Revision references unseen snapshot heads')
  const selected = ancestorClosure(operations, record.snapshot_heads)
  snapshotHeads(
    selected,
    selected.map((op) => op.op_id)
  )
  return selected
}

/** Find historical source without consulting the currently mounted editor. */
export function anchorSource(
  operations: RunmeOperation[],
  anchor: Anchor
): string | undefined {
  const selected = resolveVersion(operations, anchor.version)
  if (anchor.kind === 'notebook') return undefined
  let source: string | undefined
  let visible = false
  // V1 decisions remain part of historical materialization after copy migration.
  const decisions = new Map<
    string,
    { decision: string; operation_ids: string[] }
  >()
  for (const op of selected)
    if (op.kind === 'suggestion.review') {
      const payload = op.payload as any
      decisions.set(payload.suggestion_id, payload)
    }
  const rejected = new Set(
    [...decisions.values()].flatMap((p) =>
      p.decision === 'reject' ? p.operation_ids : []
    )
  )
  for (const op of selected) {
    if (rejected.has(op.op_id)) continue
    const p = op.payload as any
    if (p.cell_id !== anchor.cell_id) continue
    if (op.kind === 'cell.create') {
      source = p.cell.value
      visible = true
    }
    if (op.kind === 'cell.update') source = p.cell.value
    if (op.kind === 'cell.delete') visible = false
    if (op.kind === 'cell.restore') visible = true
  }
  if (source === undefined || !visible)
    throw new Error('Anchor cell does not exist at its version')
  if (anchor.range) {
    const points = Array.from(source)
    if (anchor.range.end_index > points.length)
      throw new Error('Anchor range exceeds historical source')
    const offsets = new Set<number>([0])
    let offset = 0
    const Segmenter = (
      Intl as typeof Intl & {
        Segmenter?: new (
          locale: undefined,
          options: { granularity: 'grapheme' }
        ) => { segment(text: string): Iterable<{ segment: string }> }
      }
    ).Segmenter
    if (!Segmenter) throw new Error('Grapheme validation is unavailable')
    for (const { segment } of new Segmenter(undefined, {
      granularity: 'grapheme',
    }).segment(source)) {
      offset += Array.from(segment).length
      offsets.add(offset)
    }
    if (
      !offsets.has(anchor.range.start_index) ||
      !offsets.has(anchor.range.end_index)
    )
      throw new Error('Anchor range splits a grapheme')
    return points
      .slice(anchor.range.start_index, anchor.range.end_index)
      .join('')
  }
  return source
}

/** Check new entities against their immutable causal past, never arrival order. */
export function validateRecordReferences(operations: RunmeOperation[]): void {
  const committed = committedOperationIds(operations)
  for (const op of operations) {
    if (!committed.has(op.op_id)) continue
    if (op.kind === 'revision.label' && (op.payload as any).revision) {
      const p = op.payload as any
      if (
        p.revision.kind !== 'revision' ||
        typeof p.name !== 'string' ||
        !p.name.trim() ||
        typeof p.description !== 'string'
      )
        throw new Error('Invalid revision label')
      resolveVersion(ancestorClosure(operations, op.deps), p.revision)
    }
    if (op.kind === 'revision.checkpoint') {
      resolveVersion(operations, { kind: 'revision', revision_id: op.op_id })
      continue
    }
    if (op.kind !== 'comment.record') continue
    const record = serializedRecord(op) as CommentRecord
    const past = ancestorClosure(operations, op.deps)
    const byId = operationMap(past)
    const parent = record.parent_comment_id
      ? byId.get(record.parent_comment_id)
      : undefined
    if (
      record.parent_comment_id &&
      (parent?.kind !== 'comment.record' ||
        (parent.payload as any).thread_id !== record.thread_id)
    )
      throw new Error('Comment parent is not in this thread and causal past')
    const root = record.parent_comment_id ? byId.get(record.thread_id) : op
    if (
      root?.kind !== 'comment.record' ||
      (root.payload as any).parent_comment_id
    )
      throw new Error('Comment root is invalid')
    const anchors = record.anchors ?? (root.payload as any).anchors
    const comparison = record.comparison ?? (root.payload as any).comparison
    if (
      record.parent_comment_id &&
      record.comparison &&
      JSON.stringify(record.comparison) !==
        JSON.stringify((root.payload as any).comparison)
    )
      throw new Error('A reply cannot change the thread comparison')
    const versionKey = (v: VersionRef) =>
      JSON.stringify(
        resolveVersion(past, v)
          .map((op) => op.op_id)
          .sort()
      )
    const sides = comparison
      ? [versionKey(comparison.start), versionKey(comparison.end)]
      : []
    if (comparison) {
      const base = resolveVersion(past, comparison.start).filter(
        changesNotebook
      )
      const head = new Set(
        resolveVersion(past, comparison.end)
          .filter(changesNotebook)
          .map((op) => op.op_id)
      )
      if (base.some((op) => !head.has(op.op_id)) || head.size <= base.length)
        throw new Error(
          'Comparison end must contain the start content and at least one additional change'
        )
    }
    if (record.assessment) {
      if (!comparison) throw new Error('Assessment requires a comparison')
      if (record.assessment.kind === 'cell') {
        const id = record.assessment.cell_id
        if (comparison.cell_ids && !comparison.cell_ids.includes(id))
          throw new Error('Assessment cell is outside scope')
        if (
          !([comparison.start, comparison.end] as VersionRef[]).some(
            (version) => {
              try {
                anchorSource(past, {
                  kind: 'cell',
                  cell_id: id,
                  version,
                  surface: 'source',
                })
                return true
              } catch {
                return false
              }
            }
          )
        )
          throw new Error('Assessment cell is absent from comparison')
      }
    }
    for (const anchor of anchors as Anchor[]) {
      const key = versionKey(anchor.version)
      // Roots describe the compared sides. Replies may cite later historical
      // content without changing the conversation's original comparison.
      if (comparison && !record.parent_comment_id && !sides.includes(key))
        throw new Error('Anchor is outside comparison endpoints')
      if (
        comparison?.cell_ids &&
        anchor.kind === 'cell' &&
        !comparison.cell_ids.includes(anchor.cell_id)
      )
        throw new Error('Anchor is outside comparison scope')
      anchorSource(past, anchor)
    }
    for (const cellId of comparison?.cell_ids ?? []) {
      const exists = [comparison!.start, comparison!.end].some((version) => {
        try {
          anchorSource(past, {
            kind: 'cell',
            cell_id: cellId,
            version,
            surface: 'source',
          })
          return true
        } catch {
          return false
        }
      })
      if (!exists)
        throw new Error('Comparison scope cell is absent from both endpoints')
    }
  }
}

/** Convert UI-native offsets explicitly using the captured historical source. */
export function codePointRange(source: string, start: number, end: number) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > source.length
  )
    throw new Error('Invalid UTF-16 range')
  const boundaries = new Set<number>([0])
  let offset = 0
  for (const point of source) {
    offset += point.length
    boundaries.add(offset)
  }
  if (!boundaries.has(start) || !boundaries.has(end))
    throw new Error('Range splits a surrogate pair')
  const Segmenter = Intl.Segmenter
  if (!Segmenter) throw new Error('Grapheme validation is unavailable')
  const graphemeBoundaries = new Set<number>([0])
  let graphemeOffset = 0
  for (const { segment } of new Segmenter(undefined, {
    granularity: 'grapheme',
  }).segment(source)) {
    graphemeOffset += segment.length
    graphemeBoundaries.add(graphemeOffset)
  }
  if (!graphemeBoundaries.has(start) || !graphemeBoundaries.has(end))
    throw new Error('Range splits a grapheme')
  return {
    start_index: Array.from(source.slice(0, start)).length,
    end_index: Array.from(source.slice(0, end)).length,
    unit: 'unicode-code-point' as const,
  }
}
