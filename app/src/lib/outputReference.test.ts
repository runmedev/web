import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import {
  RunmeExecutionState,
  RunmeMetadataKey,
  parser_pb,
} from '../runme/client'
import {
  buildOperationLogDiff,
  cloneNotebook,
} from './operationLog/editorJournal'
import type { RunmeOperation } from './operationLog/types'
import {
  formatOutputReference,
  parseOutputReference,
  referenceForOutput,
  resolveOutputReference,
} from './outputReference'

const bytes = (value: string) => new Uint8Array(new TextEncoder().encode(value))

/** Exercise the actual autosave journal rather than hand-invented execution records. */
async function fixture() {
  let previous = create(parser_pb.NotebookSchema)
  const operations: RunmeOperation[] = []
  const save = async (next: parser_pb.Notebook) => {
    operations.push(
      ...(await buildOperationLogDiff({
        previous,
        next,
        observedOperations: operations,
        actorId: 'writer',
        firstActorSequence: operations.length + 1,
      }))
    )
    previous = cloneNotebook(next)
  }
  const notebook = create(parser_pb.NotebookSchema, {
    cells: [
      {
        refId: 'methods',
        kind: parser_pb.CellKind.CODE,
        languageId: 'python',
        value: 'print("original")',
      },
    ],
  })
  await save(notebook)
  const cell = notebook.cells[0]
  cell.metadata[RunmeMetadataKey.LastRunID] = 'run-one'
  cell.metadata[RunmeMetadataKey.ExecutionState] = RunmeExecutionState.Running
  await save(notebook)
  cell.value = 'print("edited while running")'
  cell.metadata[RunmeMetadataKey.ExecutionState] = RunmeExecutionState.Completed
  cell.outputs = [
    create(parser_pb.CellOutputSchema, {
      items: [
        { mime: 'text/plain', data: bytes('original') },
        {
          mime: 'text/html',
          data: bytes('<table><tr><td>original</td></tr></table>'),
        },
      ],
    }),
  ]
  await save(notebook)
  return { operations, notebook, save }
}

describe('versioned output references', () => {
  it('pins the autosaved finish without a checkpoint and derives the earlier executed code', async () => {
    const { operations } = await fixture()
    const reference = referenceForOutput(operations, 'methods', 0, 1)
    expect(operations.some((op) => op.kind === 'revision.checkpoint')).toBe(
      false
    )
    expect(parseOutputReference(formatOutputReference(reference))).toEqual(
      reference
    )
    const resolved = resolveOutputReference(operations, reference)
    expect(resolved.item.mime).toBe('text/html')
    expect(resolved.source).toBe('print("original")')
    expect(resolved.executionId).toBe('run-one')
  })

  it('survives output updates, rerun, clear, source deletion, and serialized history copies', async () => {
    const { operations, notebook, save } = await fixture()
    const reference = referenceForOutput(operations, 'methods', 0, 1)
    const original = resolveOutputReference(operations, reference)
    notebook.cells[0].outputs[0].items[1].data = bytes('later display update')
    await save(notebook)
    notebook.cells[0].metadata[RunmeMetadataKey.LastRunID] = 'run-two'
    notebook.cells[0].metadata[RunmeMetadataKey.ExecutionState] =
      RunmeExecutionState.Running
    await save(notebook)
    notebook.cells[0].metadata[RunmeMetadataKey.ExecutionState] =
      RunmeExecutionState.Completed
    notebook.cells[0].outputs[0].items[1].data = bytes('new result')
    await save(notebook)
    notebook.cells[0].outputs = []
    await save(notebook)
    notebook.cells = []
    await save(notebook)
    expect(
      resolveOutputReference(JSON.parse(JSON.stringify(operations)), reference)
    ).toEqual(original)
  })

  it('pins a committed transaction and recovers the source from its exact member', async () => {
    const { operations } = await fixture()
    for (const operation of operations) operation.transaction_id = 'tx'
    const last = operations[operations.length - 1]
    const commit: RunmeOperation = {
      ...last,
      op_id: 'commit',
      actor_seq: last.actor_seq + 1,
      lamport: last.lamport + 1,
      deps: operations.map((operation) => operation.op_id),
      transaction_id: undefined,
      kind: 'transaction.commit',
      payload: {
        transaction_id: 'tx',
        members: operations.map((operation) => operation.op_id),
      },
    }
    operations.push(commit)
    const reference = referenceForOutput(operations, 'methods', 0, 1)
    expect(reference.version).toEqual({ kind: 'operation', op_id: 'commit' })
    expect(resolveOutputReference(operations, reference).source).toBe(
      'print("original")'
    )
  })

  it('reports absent history, indices and malformed output instead of falling back', async () => {
    const { operations } = await fixture()
    const reference = referenceForOutput(operations, 'methods', 0, 1)
    expect(() => resolveOutputReference([], reference)).toThrow('unavailable')
    expect(() =>
      resolveOutputReference(operations, { ...reference, itemIndex: 20 })
    ).toThrow('unavailable')
    const corrupt = structuredClone(operations)
    const finish = corrupt.find((op) => op.kind === 'execution.finish')!
    ;(finish.payload as any).outputs = ['broken']
    expect(() => resolveOutputReference(corrupt, reference)).toThrow()
  })

  it('keeps valid output available when recorded source is inconsistent', async () => {
    const { operations } = await fixture()
    const reference = referenceForOutput(operations, 'methods', 0, 1)
    const start = operations.find((op) => op.kind === 'execution.start')!
    ;(start.payload as any).input.value = 'different'
    const result = resolveOutputReference(operations, reference)
    expect(result.item.mime).toBe('text/html')
    expect(result.source).toBeUndefined()
    expect(result.provenanceError).toContain('unavailable')
  })

  it.each([
    '<script>alert(1)</script>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="#cell=x&version=operation:v&output_item=0.0" onclick="alert(1)">x</a>',
    '<a href="#cell=x&version=operation:v&output_item=0.0"><img src=x></a>',
    '<a href="#cell=x&version=latest&output_item=0.0">x</a>',
    '<a href="#cell=x&version=operation:v&output_item=-1.0">x</a>',
    '<a href="#cell=x&cell=y&version=operation:v&output_item=0.0">x</a>',
    '<a href="https://example.com/#cell=x&version=operation:v&output_item=0.0">x</a>',
  ])('rejects invalid or executable anchor source %s', (source) => {
    expect(() => parseOutputReference(source)).toThrow()
  })
})
