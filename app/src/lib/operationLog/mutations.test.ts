import { describe, expect, it } from 'vitest'

import {
  type RunmeOperation,
  causalHeads,
  createRunmeOperation,
  highestActorSequence,
} from '.'

function create({
  actorId,
  actorSequence,
  dependencies = [],
  knownOperations,
}: {
  actorId: string
  actorSequence: number
  dependencies?: string[]
  knownOperations: RunmeOperation[]
}): RunmeOperation {
  return createRunmeOperation({
    actorId,
    actorSequence,
    dependencies,
    knownOperations,
    kind: 'test.operation',
    payload: {},
    createdAt: '2026-09-03T00:00:00Z',
  })
}

describe('operation creation', () => {
  it('derives identity and Lamport time from explicit dependencies', () => {
    const root = create({
      actorId: 'actor_a',
      actorSequence: 1,
      knownOperations: [],
    })
    const child = create({
      actorId: 'actor_b',
      actorSequence: 1,
      dependencies: [root.op_id],
      knownOperations: [root],
    })
    expect(root).toMatchObject({ op_id: 'actor_a:1', lamport: 1, deps: [] })
    expect(child).toMatchObject({
      op_id: 'actor_b:1',
      lamport: 2,
      deps: ['actor_a:1'],
    })
  })

  it('preserves an observed stale frontier instead of rebasing implicitly', () => {
    const root = create({
      actorId: 'actor_seed',
      actorSequence: 1,
      knownOperations: [],
    })
    const unseen = create({
      actorId: 'actor_b',
      actorSequence: 1,
      dependencies: [root.op_id],
      knownOperations: [root],
    })
    const staleWrite = create({
      actorId: 'actor_a',
      actorSequence: 1,
      dependencies: [root.op_id],
      knownOperations: [root, unseen],
    })
    expect(staleWrite.deps).toEqual([root.op_id])
    expect(staleWrite.deps).not.toContain(unseen.op_id)
  })

  it('reports heads and recovers the next actor sequence', () => {
    const root = create({
      actorId: 'actor_a',
      actorSequence: 1,
      knownOperations: [],
    })
    const left = create({
      actorId: 'actor_a',
      actorSequence: 2,
      dependencies: [root.op_id],
      knownOperations: [root],
    })
    const right = create({
      actorId: 'actor_b',
      actorSequence: 1,
      dependencies: [root.op_id],
      knownOperations: [root],
    })
    expect(causalHeads([right, root, left])).toEqual([left.op_id, right.op_id])
    expect(highestActorSequence([right, root, left], 'actor_a')).toBe(2)
  })

  it('rejects reused actor sequences and unseen dependencies', () => {
    const root = create({
      actorId: 'actor_a',
      actorSequence: 1,
      knownOperations: [],
    })
    expect(() =>
      create({
        actorId: 'actor_a',
        actorSequence: 1,
        knownOperations: [root],
      })
    ).toThrow('has already been allocated')
    expect(() =>
      create({
        actorId: 'actor_b',
        actorSequence: 1,
        dependencies: ['missing:1'],
        knownOperations: [root],
      })
    ).toThrow('unseen dependency')
  })
})
