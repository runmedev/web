import { type CodeModeExecutor, getCodeModeErrorOutput } from './codeModeExecutor'

type CodexWasmCodeExecutorRequest = {
  source?: unknown
  stored_values?: unknown
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function normalizeStoredValues(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function encodeCodeExecutorResult(args: {
  output: string
  storedValues?: unknown
  errorText?: string
}): string {
  return JSON.stringify({
    output: args.output,
    stored_values: normalizeStoredValues(args.storedValues),
    ...(args.errorText ? { error_text: args.errorText } : {}),
  })
}

export function createCodexWasmCodeExecutor(options: {
  codeModeExecutor: CodeModeExecutor
}): (input: string) => Promise<string> {
  return async (input: string) => {
    let request: CodexWasmCodeExecutorRequest = {}
    try {
      request = JSON.parse(input) as CodexWasmCodeExecutorRequest
    } catch (error) {
      return encodeCodeExecutorResult({
        output: '',
        errorText: `Invalid code executor request: ${error}`,
      })
    }

    try {
      const result = await options.codeModeExecutor.execute({
        code: normalizeString(request.source),
        source: 'codex',
      })
      return encodeCodeExecutorResult({
        output: result.output,
        storedValues: request.stored_values,
      })
    } catch (error) {
      return encodeCodeExecutorResult({
        output: getCodeModeErrorOutput(error),
        storedValues: request.stored_values,
        errorText: String(error),
      })
    }
  }
}
