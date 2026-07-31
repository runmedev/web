type JsonRecord = Record<string, unknown>

export const EXECUTE_CODE_TOOL_NAME = 'ExecuteCode'
export const EXECUTE_CODE_TOOL_TITLE = 'Runme Execute Code'
export const EXECUTE_CODE_TOOL_DESCRIPTION =
  'Execute JavaScript in the Runme AppKernel sandbox and return one merged stdout/stderr output string. Use timeoutMs for intentional long-running interactions such as a timed UI tour.'

export function buildExecuteCodeInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: {
        type: 'string',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1_000,
        maximum: 60_000,
        description:
          'Optional execution timeout in milliseconds. Defaults to 15000 and is capped at 60000.',
      },
    },
    required: ['code'],
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
