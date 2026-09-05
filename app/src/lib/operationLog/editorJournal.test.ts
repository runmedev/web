import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import {
  type RunmeOperation,
  buildOperationLogDiff,
  cloneNotebook,
  materializeOperationLog,
  materializedLogToNotebook,
  mergeOperationSets,
} from '.'
import {
  RunmeExecutionState,
  RunmeMetadataKey,
  parser_pb,
} from '../../runme/client'

function notebook(
  cells: Array<{ id: string; value: string }>
): parser_pb.Notebook {
  return create(parser_pb.NotebookSchema, {
    cells: cells.map((cell) =>
      create(parser_pb.CellSchema, {
        refId: cell.id,
        kind: parser_pb.CellKind.MARKUP,
        languageId: 'markdown',
        value: cell.value,
      })
    ),
  })
}

async function apply(
  previous: parser_pb.Notebook,
  next: parser_pb.Notebook,
  observedOperations: RunmeOperation[],
  actorId: string,
  firstActorSequence = 1
): Promise<RunmeOperation[]> {
  return buildOperationLogDiff({
    previous,
    next,
    observedOperations,
    actorId,
    firstActorSequence,
    createdAt: () => '2026-09-03T00:00:00Z',
  })
}

describe('editor operation-log journal', () => {
  it('records cell creation, updates, deletion, and reordering', async () => {
    const empty = notebook([])
    const initial = notebook([
      { id: 'one', value: 'One' },
      { id: 'two', value: 'Two' },
    ])
    const created = await apply(empty, initial, [], 'actor_a')
    const changed = notebook([
      { id: 'two', value: 'Two updated' },
      { id: 'three', value: 'Three' },
    ])
    const updates = await apply(initial, changed, created, 'actor_a', 3)
    const kinds = updates.map((operation) => operation.kind)
    expect(kinds).toContain('cell.delete')
    expect(kinds).toContain('cell.update')
    expect(kinds).toContain('cell.create')
    expect(
      new Set(updates.map((operation) => operation.suggestion_id))
    ).toEqual(new Set(['actor_a:suggestion:3']))
    expect(created[0].suggestion_id).toBe('actor_a:suggestion:1')

    const materialized = materializeOperationLog([...created, ...updates])
    expect(
      materialized.notebook.cells.map((cell) => [cell.cell_id, cell.value])
    ).toEqual([
      ['two', 'Two updated'],
      ['three', 'Three'],
    ])
  })

  it('merges concurrent insertions into the same observed gap', async () => {
    const empty = notebook([])
    const anchors = notebook([
      { id: 'left', value: 'Left' },
      { id: 'right', value: 'Right' },
    ])
    const seed = await apply(empty, anchors, [], 'actor_seed')
    const aliceView = notebook([
      { id: 'left', value: 'Left' },
      { id: 'alice', value: 'Alice' },
      { id: 'right', value: 'Right' },
    ])
    const bobView = notebook([
      { id: 'left', value: 'Left' },
      { id: 'bob', value: 'Bob' },
      { id: 'right', value: 'Right' },
    ])
    const alice = await apply(anchors, aliceView, seed, 'actor_alice')
    const bob = await apply(anchors, bobView, seed, 'actor_bob')
    const merged = mergeOperationSets([...seed, ...alice], [...seed, ...bob])

    expect(
      materializeOperationLog(merged).notebook.cells.map((cell) => cell.cell_id)
    ).toEqual(['left', 'alice', 'bob', 'right'])
  })

  it('restores a deleted stable cell id instead of creating it twice', async () => {
    const initial = notebook([{ id: 'one', value: 'Original' }])
    const seed = await apply(notebook([]), initial, [], 'actor_seed')
    const deleted = await apply(initial, notebook([]), seed, 'actor_a')
    const restoredNotebook = notebook([{ id: 'one', value: 'Restored' }])
    const restored = await apply(
      notebook([]),
      restoredNotebook,
      [...seed, ...deleted],
      'actor_a',
      2
    )

    expect(restored.map((operation) => operation.kind)).toEqual([
      'cell.restore',
      'cell.update',
    ])
    expect(
      materializeOperationLog([
        ...seed,
        ...deleted,
        ...restored,
      ]).notebook.cells.map((cell) => [cell.cell_id, cell.value])
    ).toEqual([['one', 'Restored']])
  })

  it('round-trips non-core cell and frontmatter protobuf fields', async () => {
    const source = create(parser_pb.NotebookSchema, {
      frontmatter: create(parser_pb.FrontmatterSchema, {
        shell: 'bash',
        cwd: '/workspace',
        skipPrompts: true,
        terminalRows: '24',
        runme: create(parser_pb.FrontmatterRunmeSchema, {
          id: 'notebook-id',
          version: 'v1',
          session: create(parser_pb.RunmeSessionSchema, {
            id: 'session-id',
            document: create(parser_pb.RunmeSessionDocumentSchema, {
              relativePath: 'demo.runme',
            }),
          }),
        }),
      }),
      cells: [
        create(parser_pb.CellSchema, {
          refId: 'rich-cell',
          kind: parser_pb.CellKind.CODE,
          languageId: 'bash',
          value: 'echo hi',
          role: parser_pb.CellRole.USER,
          callId: 'call-1',
          textRange: create(parser_pb.TextRangeSchema, { start: 2, end: 9 }),
          executionSummary: create(parser_pb.CellExecutionSummarySchema, {
            executionOrder: 7,
            success: true,
            timing: create(parser_pb.ExecutionSummaryTimingSchema, {
              startTime: 10n,
              endTime: 20n,
            }),
          }),
        }),
      ],
    })

    const operations = await apply(notebook([]), source, [], 'actor_seed')
    const reopened = materializedLogToNotebook(
      materializeOperationLog(operations)
    )

    expect(reopened.frontmatter).toMatchObject({
      cwd: '/workspace',
      skipPrompts: true,
      terminalRows: '24',
      runme: {
        id: 'notebook-id',
        version: 'v1',
        session: {
          id: 'session-id',
          document: { relativePath: 'demo.runme' },
        },
      },
    })
    expect(reopened.cells[0]).toMatchObject({
      refId: 'rich-cell',
      role: parser_pb.CellRole.USER,
      callId: 'call-1',
      textRange: { start: 2, end: 9 },
      executionSummary: {
        executionOrder: 7,
        success: true,
        timing: { startTime: 10n, endTime: 20n },
      },
    })
  })

  it('records execution start and finish with materialized outputs', async () => {
    const initial = notebook([{ id: 'one', value: 'echo hello' }])
    initial.cells[0]!.kind = parser_pb.CellKind.CODE
    initial.cells[0]!.languageId = 'bash'
    const seed = await apply(notebook([]), initial, [], 'actor_seed')
    const running = cloneNotebook(initial)
    running.cells[0]!.metadata = {
      [RunmeMetadataKey.LastRunID]: 'run-1',
      [RunmeMetadataKey.ExecutionState]: RunmeExecutionState.Running,
    }
    const started = await apply(initial, running, seed, 'actor_a')
    const completed = cloneNotebook(running)
    completed.cells[0]!.metadata[RunmeMetadataKey.ExecutionState] =
      RunmeExecutionState.Completed
    completed.cells[0]!.metadata[RunmeMetadataKey.ExitCode] = '0'
    completed.cells[0]!.outputs = [
      create(parser_pb.CellOutputSchema, {
        items: [
          create(parser_pb.CellOutputItemSchema, {
            mime: 'text/plain',
            data: new TextEncoder().encode('hello\n'),
          }),
        ],
      }),
    ]
    const finished = await apply(
      running,
      completed,
      [...seed, ...started],
      'actor_a',
      3
    )

    expect(started.map((operation) => operation.kind)).toContain(
      'execution.start'
    )
    expect(finished.map((operation) => operation.kind)).toContain(
      'execution.finish'
    )
    const materialized = materializeOperationLog([
      ...seed,
      ...started,
      ...finished,
    ])
    expect(materialized.executions).toHaveLength(1)
    expect(materialized.notebook.cells[0]?.outputs).toHaveLength(1)
    expect(
      materializedLogToNotebook(materialized).cells[0]?.outputs
    ).toHaveLength(1)
  })
})
