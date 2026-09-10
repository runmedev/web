import { canonicalJsonEqual } from './canonicalJson'
import type { ExecutionFinishPayload, JsonValue, RunmeOperation } from './types'

export interface ExecutionFinishRecord {
  payload: ExecutionFinishPayload
  operationId: string
}

/** Follow dependencies, not timestamps or file order, to identify output updates. */
export function operationObserves(
  operation: RunmeOperation,
  ancestorId: string,
  operations: Map<string, RunmeOperation>
): boolean {
  const pending = [...operation.deps]
  const visited = new Set<string>()
  while (pending.length) {
    const id = pending.pop()!
    if (id === ancestorId) return true
    if (visited.has(id)) continue
    visited.add(id)
    pending.push(...(operations.get(id)?.deps ?? []))
  }
  return false
}

/** Retain concurrent finishes; a causally later finish includes late output. */
export function advanceExecutionFinishes(
  previous: ExecutionFinishRecord[],
  operation: RunmeOperation,
  operations: Map<string, RunmeOperation>
): ExecutionFinishRecord[] {
  return [
    ...previous.filter(
      (finish) => !operationObserves(operation, finish.operationId, operations)
    ),
    {
      payload: operation.payload as unknown as ExecutionFinishPayload,
      operationId: operation.op_id,
    },
  ]
}

/** Concurrent identical results are harmless; conflicting results stay visible as an error. */
export function executionFinishError(
  finishes: ExecutionFinishRecord[]
): string | undefined {
  const first = finishes[0]!.payload
  const executionIds = [
    ...new Set(finishes.map(({ payload }) => payload.execution_id)),
  ]
  const subject =
    executionIds.length === 1
      ? `Execution ${first.execution_id} has`
      : `Concurrent executions ${executionIds.join(', ')} have`
  const result = (payload: ExecutionFinishPayload): JsonValue => ({
    status: payload.status,
    outputs: payload.outputs,
    execution_summary: payload.execution_summary,
  })
  try {
    if (
      finishes.some(
        ({ payload }) =>
          !Array.isArray(payload.outputs) ||
          !['succeeded', 'failed', 'cancelled', 'lost'].includes(
            payload.status
          ) ||
          !payload.execution_summary ||
          !canonicalJsonEqual(result(first), result(payload))
      )
    ) {
      return `${subject} conflicting or invalid completion records. The saved output cannot be determined. Run this cell again to replace this error with new output.`
    }
  } catch {
    return `Execution ${first.execution_id} has invalid saved output. Run this cell again to replace this error with new output.`
  }
  return undefined
}
