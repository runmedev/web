// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createCodexWasmChatkitFetch } from './codexWasmChatkitFetch'

const submitTurnMock = vi.fn<
  (args: { prompt: string; onEvent: (event: Record<string, unknown>) => void }) => Promise<string>
>()

vi.mock('./codexWasmSession', () => ({
  createCodexWasmSession: () => ({
    submitTurn: submitTurnMock,
  }),
}))

describe('codexWasmChatkitFetch', () => {
  beforeEach(() => {
    submitTurnMock.mockReset()
  })

  it('maps a threads.create request into ChatKit stream events', async () => {
    submitTurnMock.mockImplementationOnce(async ({ onEvent }) => {
      onEvent({
        id: 'event-1',
        msg: {
          type: 'task_started',
        },
      })
      onEvent({
        id: 'event-2',
        msg: {
          type: 'agent_message_delta',
          delta: 'hello from codex wasm',
        },
      })
      onEvent({
        id: 'event-3',
        msg: {
          type: 'task_complete',
          last_agent_message: 'hello from codex wasm',
        },
      })
      return 'submission-1'
    })

    const fetchFn = createCodexWasmChatkitFetch({
      codeModeExecutor: {
        execute: vi.fn(async () => ({ output: '' })),
      },
    })

    const response = await fetchFn('/codex/wasm/chatkit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'threads.create',
        params: {
          input: {
            content: [{ type: 'input_text', text: 'say hello' }],
          },
        },
      }),
    })

    const body = await response.text()
    expect(body).toContain('"type":"thread.created"')
    expect(body).toContain('"type":"thread.item.added"')
    expect(body).toContain('"type":"thread.item.updated"')
    expect(body).toContain('hello from codex wasm')
    expect(body).toContain('"type":"aisre.chatkit.state"')
    expect(body).toContain('"type":"response.completed"')
  })

  it('returns an unsupported response for client tool output requests', async () => {
    const fetchFn = createCodexWasmChatkitFetch({
      codeModeExecutor: {
        execute: vi.fn(async () => ({ output: '' })),
      },
    })

    const response = await fetchFn('/codex/wasm/chatkit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'threads.add_client_tool_output',
        params: {
          thread_id: 'thread-1',
        },
      }),
    })

    const payload = JSON.parse(await response.text()) as { error?: string }
    expect(payload.error).toBe('client_tool_output_not_supported_for_codex_wasm')
  })
})
