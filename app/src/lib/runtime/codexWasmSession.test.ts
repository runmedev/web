// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetResponsesDirectConfigManagerForTests } from './responsesDirectConfigManager'

const submitTurnMock =
  vi.fn<
    (prompt: string, onEvent: (event: unknown) => void) => Promise<unknown>
  >()
const setApiKeyMock = vi.fn<(apiKey: string) => void>()
const setSessionOptionsMock = vi.fn<(options: unknown) => void>()
const setCodeExecutorMock =
  vi.fn<(executor: (input: string) => Promise<string>) => void>()

vi.mock('./codexWasmHarnessLoader', () => ({
  loadCodexWasmModule: async () => ({
    BrowserCodex: class MockBrowserCodex {
      constructor(_apiKey: string) {}

      set_api_key(apiKey: string) {
        setApiKeyMock(apiKey)
      }

      setSessionOptions(options: unknown) {
        setSessionOptionsMock(options)
      }

      clearSessionOptions() {}

      set_code_executor(executor: (input: string) => Promise<string>) {
        setCodeExecutorMock(executor)
      }

      clear_code_executor() {}

      async submit_turn(
        prompt: string,
        onEvent: (event: unknown) => void
      ): Promise<unknown> {
        return submitTurnMock(prompt, onEvent)
      }
    },
  }),
}))

describe('codexWasmSession', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.removeItem('runme/responses-direct-config')
    __resetResponsesDirectConfigManagerForTests()
    const { responsesDirectConfigManager } = await import(
      './responsesDirectConfigManager'
    )
    responsesDirectConfigManager.setAuthMethod('api_key')
    responsesDirectConfigManager.setAPIKey('sk-test')
  })

  it('configures session instructions and forwards the raw user prompt', async () => {
    submitTurnMock.mockResolvedValueOnce('submission-1')

    const { createCodexWasmSession } = await import('./codexWasmSession')
    const session = createCodexWasmSession({
      codeModeExecutor: {
        execute: vi.fn(async () => ({ output: '' })),
      },
    })

    const submissionId = await session.submitTurn({
      prompt: 'How do I configure a runner in Runme?',
      onEvent: vi.fn(),
    })

    expect(submissionId).toBe('submission-1')
    expect(setApiKeyMock).toHaveBeenCalledWith('sk-test')
    expect(setSessionOptionsMock).toHaveBeenCalledTimes(1)
    expect(setSessionOptionsMock).toHaveBeenCalledWith({
      cwd: '/workspace',
      instructions: {
        developer: expect.stringContaining(
          'Executed JavaScript runs inside the Runme AppKernel runtime.'
        ),
      },
    })
    expect(setCodeExecutorMock).toHaveBeenCalledTimes(1)
    expect(submitTurnMock).toHaveBeenCalledWith(
      'How do I configure a runner in Runme?',
      expect.any(Function)
    )
  })
})
