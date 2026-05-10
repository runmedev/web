type JsonRecord = Record<string, unknown>

export const EXECUTE_CODE_TOOL_NAME = 'ExecuteCode'
export const EXECUTE_CODE_TOOL_TITLE = 'Runme Execute Code'
export const EXECUTE_CODE_TOOL_DESCRIPTION =
  'Execute JavaScript in the Runme AppKernel sandbox and return one merged stdout/stderr output string.'

export function buildExecuteCodeInputSchema(): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: {
        type: 'string',
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
