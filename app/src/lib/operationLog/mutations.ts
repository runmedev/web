import { validateOperation } from './codec'
import { compareOperations, operationMap, orderOperationSet } from './order'
import type { JsonValue, RunmeOperation } from './types'

export interface CreateOperationInput<Payload = JsonValue> {
  actorId: string
  actorSequence: number
  dependencies: string[]
  knownOperations: RunmeOperation[]
  kind: string
  payload: Payload
  transactionId?: string
  reverts?: string[]
  createdAt?: string
}

/** Return the highest sequence already present for one operation-log actor. */
export function highestActorSequence(
  operations: RunmeOperation[],
  actorId: string
): number {
  return operations.reduce(
    (highest, operation) =>
      operation.actor_id === actorId
        ? Math.max(highest, operation.actor_seq)
        : highest,
    0
  )
}

/** Return the causally maximal operations in the visible, non-pending set. */
export function causalHeads(operations: RunmeOperation[]): string[] {
  const { ordered } = orderOperationSet(operations)
  const dependedUpon = new Set(ordered.flatMap((operation) => operation.deps))
  return ordered
    .filter((operation) => !dependedUpon.has(operation.op_id))
    .sort(compareOperations)
    .map((operation) => operation.op_id)
}

/** Create one deterministic operation from an explicitly observed frontier. */
export function createRunmeOperation<Payload = JsonValue>({
  actorId,
  actorSequence,
  dependencies,
  knownOperations,
  kind,
  payload,
  transactionId,
  reverts,
  createdAt = new Date().toISOString(),
}: CreateOperationInput<Payload>): RunmeOperation<string, Payload> {
  const byId = operationMap(knownOperations)
  if (actorSequence <= highestActorSequence(knownOperations, actorId)) {
    throw new Error(
      `Actor ${actorId} sequence ${actorSequence} has already been allocated`
    )
  }
  const dependencyOperations = dependencies.map((dependency) => {
    const operation = byId.get(dependency)
    if (!operation) {
      throw new Error(
        `Cannot create an operation with unseen dependency ${dependency}`
      )
    }
    return operation
  })
  const lamport =
    dependencyOperations.length === 0
      ? 1
      : Math.max(
          ...dependencyOperations.map((operation) => operation.lamport)
        ) + 1
  const operation: RunmeOperation<string, Payload> = {
    record_type: 'runme.operation',
    format_version: 1,
    op_id: `${actorId}:${actorSequence}`,
    actor_id: actorId,
    actor_seq: actorSequence,
    lamport,
    deps: [...new Set(dependencies)],
    ...(transactionId ? { transaction_id: transactionId } : {}),
    ...(reverts?.length ? { reverts: [...new Set(reverts)] } : {}),
    created_at: createdAt,
    kind,
    payload,
  }
  validateOperation(operation)
  return operation
}
