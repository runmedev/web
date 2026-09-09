import type { Anchor, VersionRef } from './records'

/** Fail closed on malformed V2 records; semantic references are checked at replay. */
export function validateRecordShape(value: any): void {
  if (value.format_version !== 2)
    throw new Error('First-class records require format version 2')
  if (
    !value.author ||
    typeof value.author.displayName !== 'string' ||
    !['human', 'agent', 'service-account', 'unknown'].includes(
      value.author.kind
    )
  )
    throw new Error('Invalid record attribution')
  if ('kind' in value || 'payload' in value)
    throw new Error('First-class records must not nest operation payloads')
  if (value.record_type === 'runme.revision') {
    stringSet(value.snapshot_heads, 'snapshot_heads', true)
    if (
      value.name !== undefined &&
      (typeof value.name !== 'string' ||
        !value.name.trim() ||
        value.name.length > 200)
    )
      throw new Error('Invalid revision name')
    if (
      value.description !== undefined &&
      (typeof value.description !== 'string' || value.description.length > 2000)
    )
      throw new Error('Invalid revision description')
    return
  }
  if (value.record_type !== 'runme.comment')
    throw new Error('Unknown first-class record')
  if (typeof value.thread_id !== 'string' || !value.thread_id)
    throw new Error('Missing thread ID')
  if (
    value.parent_comment_id !== undefined &&
    (typeof value.parent_comment_id !== 'string' || !value.parent_comment_id)
  )
    throw new Error('Invalid parent comment')
  if (!value.parent_comment_id && value.thread_id !== value.op_id)
    throw new Error('Root thread ID must equal its operation ID')
  if (
    value.body?.format !== 'text/markdown' ||
    typeof value.body.value !== 'string' ||
    !value.body.value.trim()
  )
    throw new Error('Comment body must not be empty')
  if (!value.parent_comment_id && !value.anchors?.length)
    throw new Error('Root comment requires anchors')
  if (value.anchors !== undefined) {
    if (!Array.isArray(value.anchors) || !value.anchors.length)
      throw new Error('Invalid anchors')
    value.anchors.forEach(validateAnchor)
  }
  if (value.comparison) {
    validateVersionRef(value.comparison.start)
    validateVersionRef(value.comparison.end)
    if (value.comparison.cell_ids !== undefined)
      stringSet(value.comparison.cell_ids, 'cell_ids')
  }
  if (value.assessment) {
    const a = value.assessment
    if (
      a.kind === 'scope' &&
      ['good_enough', 'needs_more_work'].includes(a.outcome)
    )
      return
    if (
      a.kind === 'cell' &&
      typeof a.cell_id === 'string' &&
      a.cell_id &&
      ['accept', 'undo'].includes(a.decision)
    )
      return
    throw new Error('Invalid assessment')
  }
}

/** Set-valued IDs have one canonical ordering independent of writer order. */
function stringSet(value: unknown, name: string, allowEmpty = false): void {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && !value.length) ||
    value.some((id) => typeof id !== 'string' || !id) ||
    new Set(value).size !== value.length
  )
    throw new Error(`Invalid ${name}`)
}

export function validateVersionRef(value: any): asserts value is VersionRef {
  const id =
    value?.kind === 'operation'
      ? value.op_id
      : value?.kind === 'revision'
        ? value.revision_id
        : null
  if (typeof id !== 'string' || !id)
    throw new Error('Invalid version reference')
}

export function validateAnchor(value: any): asserts value is Anchor {
  validateVersionRef(value?.version)
  if ('quote' in value)
    throw new Error('Quoted text must be derived, not stored')
  if (value.kind === 'notebook') return
  if (
    value.kind !== 'cell' ||
    typeof value.cell_id !== 'string' ||
    !value.cell_id ||
    value.surface !== 'source'
  )
    throw new Error('Invalid cell anchor')
  if (value.range) {
    const r = value.range
    if (
      r.unit !== 'unicode-code-point' ||
      !Number.isSafeInteger(r.start_index) ||
      !Number.isSafeInteger(r.end_index) ||
      r.start_index < 0 ||
      r.end_index <= r.start_index
    )
      throw new Error('Invalid source range')
  }
}
