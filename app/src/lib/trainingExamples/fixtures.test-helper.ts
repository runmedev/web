import { causalHeads, createRunmeOperation } from '../operationLog/mutations'
import {
  type CommentRecord,
  type RevisionRecord,
  type VersionRef,
  projectRecord,
} from '../operationLog/records'
import type { JsonValue, RunmeOperation } from '../operationLog/types'

/** A real causal journal, not a second implementation of notebook materialization. */
export function exampleJournal() {
  const operations: RunmeOperation[] = []
  const append = (kind: string, payload: unknown) => {
    const op = createRunmeOperation({
      actorId: 'test',
      actorSequence: operations.length + 1,
      dependencies: causalHeads(operations),
      knownOperations: operations,
      kind,
      payload: payload as JsonValue,
    })
    operations.push(op)
    return { kind: 'operation', op_id: op.op_id } as VersionRef
  }
  const cell = (id: string, value: string, insert = false, position = 100) =>
    append(insert ? 'cell.create' : 'cell.update', {
      cell_id: id,
      ...(insert
        ? { position: [[position, 'test', operations.length + 1]] }
        : {}),
      cell: {
        kind: 'code',
        language_id: 'bash',
        value,
        metadata: { secretAuthor: 'hidden-author' },
      },
    })
  const name = (label: string, heads = causalHeads(operations)) => {
    append('entity', {})
    const { kind: _kind, payload: _payload, ...envelope } = operations.pop()!
    const record: RevisionRecord = {
      ...envelope,
      record_type: 'runme.revision',
      format_version: 2,
      snapshot_heads: heads,
      name: label,
      author: { displayName: 'hidden-author', kind: 'human' },
    }
    operations.push(projectRecord(record))
    return { kind: 'revision', revision_id: record.op_id } as VersionRef
  }
  const decide = (
    start: VersionRef,
    end: VersionRef,
    id: string,
    decision: 'accept' | 'undo'
  ) => {
    append('entity', {})
    const { kind: _kind, payload: _payload, ...envelope } = operations.pop()!
    const record: CommentRecord = {
      ...envelope,
      record_type: 'runme.comment',
      format_version: 2,
      thread_id: envelope.op_id,
      author: { displayName: 'hidden-author', kind: 'human' },
      body: { format: 'text/markdown', value: 'hidden-comment' },
      anchors: [{ kind: 'notebook', version: end }],
      comparison: { start, end },
      assessment: { kind: 'cell', cell_id: id, decision },
    }
    operations.push(projectRecord(record))
  }
  return { operations, append, cell, name, decide }
}

export const exampleHeader = {
  record_type: 'runme.notebook' as const,
  format_version: 2 as const,
  notebook_id: 'training-test',
  created_by: 'test',
  created_at: '2026-09-12T00:00:00Z',
}
