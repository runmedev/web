import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'

import {
  type RunmeOperation,
  buildOperationLogDiff,
  materializeOperationLog,
  mergeOperationSets,
} from '.'
import { parser_pb } from '../../runme/client'

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

function apply(
  previous: parser_pb.Notebook,
  next: parser_pb.Notebook,
  observedOperations: RunmeOperation[],
  actorId: string,
  firstActorSequence = 1
): RunmeOperation[] {
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
  it('records cell creation, updates, deletion, and reordering', () => {
    const empty = notebook([])
    const initial = notebook([
      { id: 'one', value: 'One' },
      { id: 'two', value: 'Two' },
    ])
    const created = apply(empty, initial, [], 'actor_a')
    const changed = notebook([
      { id: 'two', value: 'Two updated' },
      { id: 'three', value: 'Three' },
    ])
    const updates = apply(initial, changed, created, 'actor_a', 3)
    const kinds = updates.map((operation) => operation.kind)
    expect(kinds).toContain('cell.delete')
    expect(kinds).toContain('cell.update')
    expect(kinds).toContain('cell.create')

    const materialized = materializeOperationLog([...created, ...updates])
    expect(
      materialized.notebook.cells.map((cell) => [cell.cell_id, cell.value])
    ).toEqual([
      ['two', 'Two updated'],
      ['three', 'Three'],
    ])
  })

  it('merges concurrent insertions into the same observed gap', () => {
    const empty = notebook([])
    const anchors = notebook([
      { id: 'left', value: 'Left' },
      { id: 'right', value: 'Right' },
    ])
    const seed = apply(empty, anchors, [], 'actor_seed')
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
    const alice = apply(anchors, aliceView, seed, 'actor_alice')
    const bob = apply(anchors, bobView, seed, 'actor_bob')
    const merged = mergeOperationSets([...seed, ...alice], [...seed, ...bob])

    expect(
      materializeOperationLog(merged).notebook.cells.map((cell) => cell.cell_id)
    ).toEqual(['left', 'alice', 'bob', 'right'])
  })
})
