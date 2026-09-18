import { validateLamportValues, validateOperation } from '../operationLog/codec'
import { createRunmeOperation } from '../operationLog/mutations'
import type { NotebookRecord } from '../operationLog/records'
import type { JsonValue, RunmeOperation } from '../operationLog/types'
import type { PreparedExample } from './payloads'
import { normalizePreparedExample, replayContent } from './payloads'

/** Valid native records with deterministic training-only identity/causality.
 * Fixed envelope values remove author/time leakage without changing the source.
 */
export function contentRecords(input: PreparedExample): {
  base: NotebookRecord[]
  diff: NotebookRecord[]
} {
  const records: RunmeOperation[] = []
  const append = (kind: string, payload: unknown) => {
    const op = createRunmeOperation({
      actorId: 'content',
      actorSequence: records.length + 1,
      dependencies: records.length ? [records.at(-1)!.op_id] : [],
      knownOperations: records,
      kind,
      payload: payload as JsonValue,
    })
    op.created_at = '1970-01-01T00:00:00.000Z'
    op.format_version = 2
    records.push(op)
  }
  for (const payload of input.initial) append('cell.create', payload)
  const base = [...records]
  for (const operation of input.operations)
    append(operation.kind, operation.payload)
  return { base, diff: records.slice(base.length) }
}

/** Validate self-contained record inputs before preview or classifier encoding.
 * No source notebook or current head is consulted when replaying an example.
 */
export function prepareRecordExample(example: {
  base: NotebookRecord[]
  diff: NotebookRecord[]
}): PreparedExample {
  if (!Array.isArray(example?.base) || !Array.isArray(example?.diff))
    throw new Error('Expected example base and diff record arrays')
  const all = [...example.base, ...example.diff]
  const ids = new Set<string>()
  for (const record of all) {
    validateOperation(record)
    if (
      record.record_type !== 'runme.operation' ||
      !['cell.create', 'cell.update', 'cell.delete', 'cell.move'].includes(
        record.kind
      ) ||
      record.transaction_id ||
      ids.has(record.op_id) ||
      record.deps.some((id) => !ids.has(id))
    )
      throw new Error('Invalid self-contained content records')
    ids.add(record.op_id)
  }
  validateLamportValues(all as RunmeOperation[])
  const operations = (records: NotebookRecord[]) =>
    (records as RunmeOperation[]).map((op) => ({
      kind: op.kind,
      payload: op.payload,
    })) as unknown as PreparedExample['operations']
  // Unlike editor recovery, strict replay rejects an update/delete of a missing
  // base cell rather than silently materializing a smaller training snapshot.
  const base = replayContent([], operations(example.base))
  const input: PreparedExample = {
    initial: base,
    operations: operations(example.diff),
  }
  return normalizePreparedExample(input)
}
