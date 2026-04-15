import {
  type CodeModeExecutor,
  getCodeModeErrorOutput,
} from './codeModeExecutor'
import {
  loadCodexWasmModule,
  type BrowserCodexInstance,
} from './codexWasmHarnessLoader'
import { responsesDirectConfigManager } from './responsesDirectConfigManager'

export type CodexWasmSessionEvent = Record<string, unknown>

export type CodexWasmSession = {
  submitTurn(args: {
    prompt: string
    onEvent: (event: CodexWasmSessionEvent) => void
  }): Promise<string>
}

const RUNME_CODE_MODE_PROMPT_PREFIX = [
  'You are operating inside the Runme app ChatKit panel in a browser.',
  'When you need to inspect or modify notebooks, use Codex code mode.',
  'Executed JavaScript runs in the Runme browser sandbox.',
  'The runtime inside executed code exposes helpers named runme, notebooks, and help.',
  'Always await helper calls before reading or logging their results.',
  'Use concise JavaScript snippets and report concrete notebook-visible results.',
].join('\n')

function buildPrompt(prompt: string): string {
  return `${RUNME_CODE_MODE_PROMPT_PREFIX}\n\nUser request:\n${prompt}`
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
        return new generated.BrowserCodex(apiKey)
      })()
    }

    const browserCodex = await browserCodexPromise
    browserCodex.set_api_key(apiKey)
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
        buildPrompt(args.prompt),
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
