export const DEFAULT_EXECUTE_CODE_WAIT_TIMEOUT_MS = 15_000
export const MAX_EXECUTE_CODE_WAIT_TIMEOUT_MS = 60_000
export const DEFAULT_EXECUTE_CODE_MAX_RUNTIME_MS = 10 * 60_000
export const MAX_EXECUTE_CODE_MAX_RUNTIME_MS = 60 * 60_000
export const DEFAULT_EXECUTE_CODE_OUTPUT_BYTES = 256 * 1024
export const DEFAULT_EXECUTE_CODE_RESULT_TTL_MS = 24 * 60 * 60_000
export const DEFAULT_EXECUTE_CODE_POLL_BYTES = 64 * 1024
export const MAX_EXECUTE_CODE_POLL_WAIT_MS = 30_000

export type ExecuteCodeTimeoutBehavior = 'cancel' | 'continue'

export type ExecuteCodeOperationStatus =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'expired'

export type ExecuteCodeOperationError = {
  code: string
  message: string
  downstreamMayContinue?: boolean
}

export type ExecuteCodeOutputStream = 'stdout' | 'stderr'

export type ExecuteCodeOutputEvent = {
  operationId: string
  sequence: number
  stream: ExecuteCodeOutputStream
  text: string
  createdAt: string
}

export type ExecuteCodeOperationRecord = {
  id: string
  sessionId: string
  status: ExecuteCodeOperationStatus
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  expiresAt: string
  codeHash: string
  idempotencyKey?: string
  timeoutBehavior: ExecuteCodeTimeoutBehavior
  waitTimeoutMs: number
  maxRuntimeMs: number
  exitCode?: number
  error?: ExecuteCodeOperationError
  outputSequence: number
  retainedOutputBytes: number
  droppedOutputBytes: number
  outputTruncated: boolean
}

export type ExecuteCodeOutputPage = {
  events: ExecuteCodeOutputEvent[]
  nextSequence: number
  latestSequence: number
  hasMore: boolean
  truncated: boolean
  droppedBytes: number
}

export type ExecuteCodeOperation = {
  operationId: string
  status: ExecuteCodeOperationStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  expiresAt: string
  waitExpired: boolean
  exitCode?: number
  error?: ExecuteCodeOperationError
  output: ExecuteCodeOutputPage
  pollAfterMs?: number
}

export type StartExecuteCodeOperationInput = {
  code: string
  timeoutMs?: number
  timeoutBehavior?: ExecuteCodeTimeoutBehavior
  maxRuntimeMs?: number
  idempotencyKey?: string
}

export type GetExecuteCodeOperationInput = {
  operationId: string
  afterSequence?: number
  waitMs?: number
  maxBytes?: number
}

export type CancelExecuteCodeOperationInput = {
  operationId: string
  afterSequence?: number
  maxBytes?: number
}

export function isExecuteCodeOperationTerminal(
  status: ExecuteCodeOperationStatus
): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted' ||
    status === 'expired'
  )
}
