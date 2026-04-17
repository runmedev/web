import {
  type CodeModeExecutor,
  getCodeModeErrorOutput,
} from './codeModeExecutor'
import {
  type BrowserCodexInstance,
  loadCodexWasmModule,
} from './codexWasmHarnessLoader'
import { responsesDirectConfigManager } from './responsesDirectConfigManager'
import { buildRunmeCodexWasmSessionOptions } from './runmeChatkitPrompts'

export type CodexWasmSessionEvent = Record<string, unknown>

export type CodexWasmSession = {
  submitTurn(args: {
    prompt: string
    onEvent: (event: CodexWasmSessionEvent) => void
  }): Promise<string>
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

export function createCodexWasmSession(options: {
  codeModeExecutor: CodeModeExecutor
}): CodexWasmSession {
  let browserCodexPromise: Promise<BrowserCodexInstance> | null = null

  const getBrowserCodex = async (): Promise<BrowserCodexInstance> => {
    const apiKey = responsesDirectConfigManager.getSnapshot().apiKey.trim()
    if (!apiKey) {
      throw new Error(
        'Codex WASM requires an OpenAI API key. Run app.responsesDirect.setAPIKey(...).'
      )
    }

    if (!browserCodexPromise) {
      browserCodexPromise = (async () => {
        const generated = await loadCodexWasmModule()
        const BrowserCodex = generated.BrowserCodex
        if (!BrowserCodex) {
          throw new Error(
            'Generated codex wasm bundle does not export BrowserCodex.'
          )
        }
        return new BrowserCodex(apiKey)
      })()
    }

    const browserCodex = await browserCodexPromise
    browserCodex.set_api_key(apiKey)
    browserCodex.setSessionOptions(buildRunmeCodexWasmSessionOptions())
    browserCodex.set_code_executor(async (input: string) => {
      let request: {
        source?: unknown
        stored_values?: unknown
      } = {}
      try {
        request = JSON.parse(input) as {
          source?: unknown
          stored_values?: unknown
        }
      } catch (error) {
        return JSON.stringify({
          output: '',
          stored_values: {},
          error_text: `Invalid code executor request: ${error}`,
        })
      }

      try {
        const result = await options.codeModeExecutor.execute({
          code: normalizeString(request.source),
          source: 'codex',
        })
        return JSON.stringify({
          output: result.output,
          stored_values:
            request.stored_values &&
            typeof request.stored_values === 'object' &&
            !Array.isArray(request.stored_values)
              ? request.stored_values
              : {},
        })
      } catch (error) {
        return JSON.stringify({
          output: getCodeModeErrorOutput(error),
          stored_values:
            request.stored_values &&
            typeof request.stored_values === 'object' &&
            !Array.isArray(request.stored_values)
              ? request.stored_values
              : {},
          error_text: String(error),
        })
      }
    })
    return browserCodex
  }

  return {
    async submitTurn(args) {
      const browserCodex = await getBrowserCodex()
      const submissionId = await browserCodex.submit_turn(
        normalizeString(args.prompt),
        (event: unknown) => {
          if (event && typeof event === 'object' && !Array.isArray(event)) {
            args.onEvent(event as CodexWasmSessionEvent)
          }
        }
      )
      return String(submissionId ?? '')
    },
  }
}
