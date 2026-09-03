import { canonicalJson, canonicalJsonEqual } from './canonicalJson'
import type {
  JsonValue,
  OrderedOperationSet,
  RunmeOperation,
  TransactionCommitPayload,
} from './types'

const textEncoder = new TextEncoder()

function compareUtf8(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left)
  const rightBytes = textEncoder.encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] < rightBytes[index] ? -1 : 1
    }
  }
  return leftBytes.length < rightBytes.length
    ? -1
    : leftBytes.length > rightBytes.length
      ? 1
      : 0
}

export function compareOperations(
  left: RunmeOperation,
  right: RunmeOperation
): number {
  if (left.lamport !== right.lamport) {
    return left.lamport < right.lamport ? -1 : 1
  }
  const actorOrder = compareUtf8(left.actor_id, right.actor_id)
  if (actorOrder !== 0) return actorOrder
  if (left.actor_seq !== right.actor_seq) {
    return left.actor_seq < right.actor_seq ? -1 : 1
  }
  return compareUtf8(left.op_id, right.op_id)
}

export function operationMap(
  operations: RunmeOperation[]
): Map<string, RunmeOperation> {
  const result = new Map<string, RunmeOperation>()
  for (const operation of operations) {
    const existing = result.get(operation.op_id)
    if (existing) {
      if (
        !canonicalJsonEqual(
          existing as unknown as JsonValue,
          operation as unknown as JsonValue
        )
      ) {
        throw new Error(`Conflicting operations share op_id ${operation.op_id}`)
      }
      continue
    }
    result.set(operation.op_id, operation)
  }
  return result
}

function pendingClosure(operations: Map<string, RunmeOperation>): Set<string> {
  const pending = new Set<string>()
  for (const operation of operations.values()) {
    if (operation.deps.some((dependency) => !operations.has(dependency))) {
      pending.add(operation.op_id)
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const operation of operations.values()) {
      if (
        !pending.has(operation.op_id) &&
        operation.deps.some((dependency) => pending.has(dependency))
      ) {
        pending.add(operation.op_id)
        changed = true
      }
    }
  }
  return pending
}

export function orderOperationSet(
  operations: RunmeOperation[]
): OrderedOperationSet {
  const byId = operationMap(operations)
  const pendingIds = pendingClosure(byId)
  const active = new Map(
    [...byId].filter(([operationId]) => !pendingIds.has(operationId))
  )
  const unmet = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const operation of active.values()) {
    const dependencies = operation.deps.filter((dependency) =>
      active.has(dependency)
    )
    unmet.set(operation.op_id, dependencies.length)
    for (const dependency of dependencies) {
      const children = dependents.get(dependency) ?? []
      children.push(operation.op_id)
      dependents.set(dependency, children)
    }
  }

  const ready = [...active.values()]
    .filter((operation) => unmet.get(operation.op_id) === 0)
    .sort(compareOperations)
  const ordered: RunmeOperation[] = []

  while (ready.length > 0) {
    const operation = ready.shift()!
    ordered.push(operation)
    for (const childId of dependents.get(operation.op_id) ?? []) {
      const next = (unmet.get(childId) ?? 0) - 1
      unmet.set(childId, next)
      if (next === 0) {
        ready.push(active.get(childId)!)
        ready.sort(compareOperations)
      }
    }
  }

  if (ordered.length !== active.size) {
    throw new Error('Operation dependency graph contains a cycle')
  }

  return {
    ordered,
    pending: [...pendingIds]
      .map((operationId) => byId.get(operationId)!)
      .sort(compareOperations),
  }
}

function dependsOn(
  operationId: string,
  expectedAncestorId: string,
  operations: Map<string, RunmeOperation>,
  seen = new Set<string>()
): boolean {
  if (operationId === expectedAncestorId) return true
  if (seen.has(operationId)) return false
  seen.add(operationId)
  const operation = operations.get(operationId)
  return Boolean(
    operation?.deps.some((dependency) =>
      dependsOn(dependency, expectedAncestorId, operations, seen)
    )
  )
}

/** Return operation IDs whose effects are committed and materializable. */
export function committedOperationIds(
  operations: RunmeOperation[]
): Set<string> {
  const byId = operationMap(operations)
  const pending = pendingClosure(byId)
  const committed = new Set<string>()

  for (const operation of byId.values()) {
    if (
      !operation.transaction_id &&
      operation.kind !== 'transaction.commit' &&
      !pending.has(operation.op_id)
    ) {
      committed.add(operation.op_id)
    }
  }

  for (const commit of byId.values()) {
    if (commit.kind !== 'transaction.commit' || pending.has(commit.op_id)) {
      continue
    }
    if (commit.transaction_id) {
      throw new Error(
        `transaction.commit ${commit.op_id} must not carry transaction_id`
      )
    }
    const payload = commit.payload as unknown as TransactionCommitPayload
    if (
      !payload ||
      typeof payload.transaction_id !== 'string' ||
      !Array.isArray(payload.members)
    ) {
      throw new Error(`Invalid transaction.commit payload for ${commit.op_id}`)
    }
    const members = new Set(payload.members)
    if (members.size !== payload.members.length) {
      throw new Error(
        `Transaction ${payload.transaction_id} contains duplicate members`
      )
    }
    for (const memberId of members) {
      const member = byId.get(memberId)
      if (!member) continue
      if (member.transaction_id !== payload.transaction_id) {
        throw new Error(
          `Transaction member ${memberId} has the wrong transaction_id`
        )
      }
      if (!dependsOn(commit.op_id, memberId, byId)) {
        throw new Error(
          `Transaction commit ${commit.op_id} does not depend on ${memberId}`
        )
      }
    }
    if (
      payload.members.every(
        (memberId) => byId.has(memberId) && !pending.has(memberId)
      )
    ) {
      for (const memberId of payload.members) committed.add(memberId)
      committed.add(commit.op_id)
    }
  }
  return committed
}

export function mergeOperationSets(
  left: RunmeOperation[],
  right: RunmeOperation[]
): RunmeOperation[] {
  const merged = operationMap([...left, ...right])
  const result = orderOperationSet([...merged.values()])
  return [...result.ordered, ...result.pending]
}

export function canonicalOperationKey(operation: RunmeOperation): string {
  return canonicalJson(operation as unknown as JsonValue)
}
