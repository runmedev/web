import { MIN_EXECUTE_CODE_POLL_BYTES } from './codeOperationTypes'

type JsonRecord = Record<string, unknown>

export const EXECUTE_CODE_TOOL_NAME = 'ExecuteCode'
export const EXECUTE_CODE_TOOL_TITLE = 'Runme Execute Code'
export const EXECUTE_CODE_TOOL_DESCRIPTION =
  'Start JavaScript in the Runme AppKernel sandbox and return a JSON operation snapshot. Read notebooks with notebooks.get({ uri }) and access cells through doc.notebook.cells; notebooks.read is not an API. Call await notebooks.help() when uncertain. Fast work completes inline. Long work continues by default after timeoutMs and can be polled with GetExecuteCodeOperation. Every accepted request returns a Runme-assigned operationId.'

export const GET_EXECUTE_CODE_OPERATION_TOOL_NAME = 'GetExecuteCodeOperation'
export const GET_EXECUTE_CODE_OPERATION_TOOL_TITLE =
  'Get Runme Execute Code Operation'
export const GET_EXECUTE_CODE_OPERATION_TOOL_DESCRIPTION =
  'Poll an ExecuteCode operation by its Runme-assigned operationId. Use afterSequence to retrieve only new stdout/stderr events and waitMs for bounded long polling.'

export const CANCEL_EXECUTE_CODE_OPERATION_TOOL_NAME =
  'CancelExecuteCodeOperation'
export const CANCEL_EXECUTE_CODE_OPERATION_TOOL_TITLE =
  'Cancel Runme Execute Code Operation'
export const CANCEL_EXECUTE_CODE_OPERATION_TOOL_DESCRIPTION =
  'Request cancellation of an ExecuteCode sandbox operation. Cancellation is idempotent and does not guarantee that a downstream notebook, deployment, or cloud operation also stopped.'

export function buildExecuteCodeInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: {
        type: 'string',
        description:
          'AppKernel JavaScript. For notebook reads, use await notebooks.get({ uri }) and doc.notebook.cells. Do not call notebooks.read; it does not exist. Use await notebooks.help() to inspect the live API.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1_000,
        maximum: 60_000,
        description:
          'Optional initial response wait budget in milliseconds. Defaults to 15000 and is capped at 60000. It is not the hard execution deadline.',
      },
      timeoutBehavior: {
        type: 'string',
        enum: ['continue', 'cancel'],
        default: 'continue',
        description:
          'What to do when timeoutMs expires. continue returns a running operation for later polling; cancel aborts the sandbox. Defaults to continue.',
      },
      maxRuntimeMs: {
        type: 'integer',
        minimum: 1_000,
        maximum: 3_600_000,
        default: 600_000,
        description:
          'Hard runtime limit for the operation in milliseconds. Defaults to 600000 and is capped at 3600000.',
      },
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description:
          'Optional caller token for safely deduplicating a retried request. Runme still assigns the operationId.',
      },
    },
    required: ['code'],
  }
}

export function buildGetExecuteCodeOperationInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      operationId: {
        type: 'string',
        minLength: 1,
      },
      afterSequence: {
        type: 'integer',
        minimum: 0,
        description:
          'Return output events after this sequence number. Defaults to 0.',
      },
      waitMs: {
        type: 'integer',
        minimum: 0,
        maximum: 30_000,
        description:
          'Wait up to this many milliseconds for new output or a state change. Defaults to 0.',
      },
      maxBytes: {
        type: 'integer',
        minimum: MIN_EXECUTE_CODE_POLL_BYTES,
        maximum: 262_144,
        description:
          'Maximum retained output bytes to return in this poll. Minimum 16384; defaults to 65536.',
      },
    },
    required: ['operationId'],
  }
}

export function buildCancelExecuteCodeOperationInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      operationId: {
        type: 'string',
        minLength: 1,
      },
      afterSequence: {
        type: 'integer',
        minimum: 0,
        description:
          'Return output events after this sequence number. Defaults to 0.',
      },
      maxBytes: {
        type: 'integer',
        minimum: MIN_EXECUTE_CODE_POLL_BYTES,
        maximum: 262_144,
        description:
          'Maximum retained output bytes to return with the cancellation result. Minimum 16384; defaults to 65536.',
      },
    },
    required: ['operationId'],
  }
}

export function buildResponsesExecuteCodeToolDefinition(): JsonRecord {
  return {
    type: 'function',
    name: EXECUTE_CODE_TOOL_NAME,
    description: EXECUTE_CODE_TOOL_DESCRIPTION,
    strict: true,
    parameters: buildExecuteCodeInputSchema(),
  }
}
