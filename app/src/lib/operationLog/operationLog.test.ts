import { describe, expect, it } from 'vitest'

import {
  type JsonValue,
  type NotebookLogHeader,
  type PositionId,
  type RunmeOperation,
  allocatePositionBetween,
  canonicalJson,
  canonicalOperationKey,
  comparePositionIds,
  materializeOperationLog,
  mergeOperationSets,
  orderOperationSet,
  parseOperationLog,
  serializeOperationLog,
} from '.'

const header: NotebookLogHeader = {
  record_type: 'runme.notebook',
  format_version: 1,
  notebook_id: 'nb_test',
  created_by: 'actor_seed',
  created_at: '2026-09-03T00:00:00Z',
}

function operation({
  actor = 'actor_a',
  sequence,
  lamport,
  dependencies = [],
  kind = 'test.operation',
  payload = {},
  transactionId,
}: {
  actor?: string
  sequence: number
  lamport: number
  dependencies?: string[]
  kind?: string
  payload?: JsonValue
  transactionId?: string
}): RunmeOperation {
  return {
    record_type: 'runme.operation',
    format_version: 1,
    op_id: `${actor}:${sequence}`,
    actor_id: actor,
    actor_seq: sequence,
    lamport,
    deps: dependencies,
    ...(transactionId ? { transaction_id: transactionId } : {}),
    created_at: `2026-09-03T00:00:0${sequence}Z`,
    kind,
    payload,
  }
}

function cellCreate({
  actor,
  sequence,
  lamport,
  dependencies = [],
  cellId,
  value,
  digit,
  transactionId,
}: {
  actor: string
  sequence: number
  lamport: number
  dependencies?: string[]
  cellId: string
  value: string
  digit: number
  transactionId?: string
}): RunmeOperation {
  return operation({
    actor,
    sequence,
    lamport,
    dependencies,
    transactionId,
    kind: 'cell.create',
    payload: {
      cell_id: cellId,
      position: [[digit, actor, sequence]],
      cell: {
        kind: 'markup',
        language_id: 'markdown',
        value,
        metadata: {},
      },
    },
  })
}

describe('canonical JSON and operation-log framing', () => {
  it('sorts object keys recursively without changing array order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [3, 2, 1] })).toBe(
      '{"a":{"b":3,"y":2},"list":[3,2,1],"z":1}'
    )
  })

  it('round trips canonical JSON Lines with a required final LF', () => {
    const first = operation({ sequence: 1, lamport: 1 })
    const text = serializeOperationLog(header, [first])
    expect(text.endsWith('\n')).toBe(true)
    expect(parseOperationLog(text)).toEqual({ header, operations: [first] })
    expect(() => parseOperationLog(text.slice(0, -1))).toThrow(
      'must end with LF'
    )
  })

  it('rejects conflicting duplicate operation IDs', () => {
    const left = operation({ sequence: 1, lamport: 1, payload: { value: 'a' } })
    const right = operation({
      sequence: 1,
      lamport: 1,
      payload: { value: 'b' },
    })
    expect(() => mergeOperationSets([left], [right])).toThrow(
      'Conflicting operations share op_id actor_a:1'
    )
  })
})

describe('dense positions', () => {
  it('orders concurrent allocations in one gap by actor identity', () => {
    const left = [[100, 'actor_seed', 1]] as const
    const right = [[200, 'actor_seed', 2]] as const
    const chooseSameDigit = () => 150
    const alice = allocatePositionBetween({
      left,
      right,
      actorId: 'actor_alice',
      actorSequence: 3,
      chooseDigit: chooseSameDigit,
    })
    const bob = allocatePositionBetween({
      left,
      right,
      actorId: 'actor_bob',
      actorSequence: 9,
      chooseDigit: chooseSameDigit,
    })

    expect(comparePositionIds(left, alice)).toBeLessThan(0)
    expect(comparePositionIds(alice, bob)).toBeLessThan(0)
    expect(comparePositionIds(bob, right)).toBeLessThan(0)
  })

  it('supports imported zero positions and repeated prepends', () => {
    let first: PositionId = [[0, 'actor_seed', 1]]
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      const prepended = allocatePositionBetween({
        left: null,
        right: first,
        actorId: 'actor_prepend',
        actorSequence: sequence,
      })
      expect(comparePositionIds(prepended, first)).toBeLessThan(0)
      first = prepended
    }
  })

  it('grows a path when adjacent digits leave no numeric interval', () => {
    const left = [[100, 'actor_seed', 1]] as const
    const right = [[101, 'actor_seed', 2]] as const
    const allocated = allocatePositionBetween({
      left,
      right,
      actorId: 'actor_alice',
      actorSequence: 3,
    })

    expect(allocated).toHaveLength(2)
    expect(allocated[0]).toEqual(left[0])
    expect(comparePositionIds(left, allocated)).toBeLessThan(0)
    expect(comparePositionIds(allocated, right)).toBeLessThan(0)
  })
})

describe('causal ordering and merge', () => {
  it('preserves causality and deterministically orders concurrent operations', () => {
    const root = operation({ actor: 'actor_seed', sequence: 1, lamport: 1 })
    const bob = operation({
      actor: 'actor_bob',
      sequence: 1,
      lamport: 2,
      dependencies: [root.op_id],
    })
    const alice = operation({
      actor: 'actor_alice',
      sequence: 1,
      lamport: 2,
      dependencies: [root.op_id],
    })
    const afterAlice = operation({
      actor: 'actor_alice',
      sequence: 2,
      lamport: 3,
      dependencies: [alice.op_id],
    })

    expect(
      orderOperationSet([afterAlice, bob, root, alice]).ordered.map(
        (item) => item.op_id
      )
    ).toEqual([root.op_id, alice.op_id, bob.op_id, afterAlice.op_id])
  })

  it('keeps operations with missing dependencies and their descendants pending', () => {
    const pending = operation({
      sequence: 2,
      lamport: 2,
      dependencies: ['actor_a:1'],
    })
    const descendant = operation({
      sequence: 3,
      lamport: 3,
      dependencies: [pending.op_id],
    })
    const result = orderOperationSet([descendant, pending])
    expect(result.ordered).toEqual([])
    expect(result.pending.map((item) => item.op_id)).toEqual([
      pending.op_id,
      descendant.op_id,
    ])
  })

  it('detects dependency cycles', () => {
    const left = operation({
      sequence: 1,
      lamport: 2,
      dependencies: ['actor_a:2'],
    })
    const right = operation({
      sequence: 2,
      lamport: 2,
      dependencies: ['actor_a:1'],
    })
    expect(() => orderOperationSet([left, right])).toThrow('contains a cycle')
  })

  it('is commutative and idempotent by canonical operation identity', () => {
    const root = operation({ actor: 'actor_seed', sequence: 1, lamport: 1 })
    const alice = operation({
      actor: 'actor_alice',
      sequence: 1,
      lamport: 2,
      dependencies: [root.op_id],
    })
    const bob = operation({
      actor: 'actor_bob',
      sequence: 1,
      lamport: 2,
      dependencies: [root.op_id],
    })
    const leftRight = mergeOperationSets([root, alice], [root, bob]).map(
      canonicalOperationKey
    )
    const rightLeft = mergeOperationSets([root, bob], [root, alice]).map(
      canonicalOperationKey
    )
    expect(leftRight).toEqual(rightLeft)
    expect(mergeOperationSets([root], [root])).toEqual([root])
  })
})

describe('materialization', () => {
  it('materializes concurrent same-gap inserts in deterministic position order', () => {
    const alice = cellCreate({
      actor: 'actor_alice',
      sequence: 1,
      lamport: 1,
      cellId: 'cell_alice',
      value: 'Alice',
      digit: 150,
    })
    const bob = cellCreate({
      actor: 'actor_bob',
      sequence: 1,
      lamport: 1,
      cellId: 'cell_bob',
      value: 'Bob',
      digit: 150,
    })
    const result = materializeOperationLog([bob, alice])
    expect(result.notebook.cells.map((cell) => cell.cell_id)).toEqual([
      'cell_alice',
      'cell_bob',
    ])
  })

  it('keeps transaction members inactive until their complete commit arrives', () => {
    const member = cellCreate({
      actor: 'actor_alice',
      sequence: 1,
      lamport: 1,
      cellId: 'cell_proposed',
      value: 'Proposed',
      digit: 100,
      transactionId: 'tx_1',
    })
    expect(materializeOperationLog([member]).notebook.cells).toEqual([])

    const commit = operation({
      actor: 'actor_alice',
      sequence: 2,
      lamport: 2,
      dependencies: [member.op_id],
      kind: 'transaction.commit',
      payload: { transaction_id: 'tx_1', members: [member.op_id] },
    })
    expect(
      materializeOperationLog([commit, member]).notebook.cells.map(
        (cell) => cell.cell_id
      )
    ).toEqual(['cell_proposed'])
  })
})
