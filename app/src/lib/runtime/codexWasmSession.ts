import {
  type CodeModeExecutor,
} from './codeModeExecutor'
import { createCodexWasmCodeExecutor } from './codexWasmCodeExecutor'
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
    browserCodex.set_code_executor(
      createCodexWasmCodeExecutor({
        codeModeExecutor: options.codeModeExecutor,
      })
    )
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
