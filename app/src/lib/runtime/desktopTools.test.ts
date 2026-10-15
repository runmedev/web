import { describe, expect, it } from 'vitest'

import type {
  DesktopBridge,
  ToolRequest,
  ToolResponse,
} from '../../../../packages/desktop/src/protocol'
import { createDesktopToolContext } from './desktopTools'

describe('desktop tool adapter', () => {
  it('shares handlers with the app, propagates errors, and unregisters on cleanup', async () => {
    let listener: ((request: ToolRequest) => void) | undefined
    const responses: ToolResponse[] = []
    let catalog: unknown[] = []
    const bridge: DesktopBridge = {
      publishTools: (tools) => {
        catalog = tools
      },
      onRequest: (callback) => {
        listener = callback
        return () => {
          listener = undefined
        }
      },
      respond: (response) => {
        responses.push(response)
      },
    }
    const context = createDesktopToolContext(bridge)
    const owner = new AbortController()
    context.registerTool(
      {
        name: 'echo',
        inputSchema: { type: 'object' },
        execute: (args) => JSON.stringify(args),
      },
      { signal: owner.signal }
    )
    expect(catalog).toEqual([{ name: 'echo', inputSchema: { type: 'object' } }])
    listener?.({
      id: 'one',
      type: 'call',
      name: 'echo',
      arguments: { value: 42 },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(responses).toContainEqual({ id: 'one', result: '{"value":42}' })
    owner.abort()
    expect(catalog).toEqual([])
    expect(listener).toBeUndefined()
  })

  it('forwards cancellation as an AbortSignal to an in-flight app operation', async () => {
    let listener: ((request: ToolRequest) => void) | undefined
    let signal: AbortSignal | undefined
    let finish: (() => void) | undefined
    const context = createDesktopToolContext({
      publishTools: () => {},
      respond: () => {},
      onRequest: (callback) => {
        listener = callback
        return () => {}
      },
    })
    const owner = new AbortController()
    context.registerTool(
      {
        name: 'wait',
        inputSchema: {},
        execute: async (_args, options) => {
          signal = options?.signal
          await new Promise<void>((resolve) => {
            finish = resolve
          })
          return 'finished'
        },
      },
      { signal: owner.signal }
    )
    listener?.({ type: 'call', id: 'call', name: 'wait', arguments: {} })
    await Promise.resolve()
    listener?.({ type: 'cancel', id: 'call' })
    expect(signal?.aborted).toBe(true)
    finish?.()
    owner.abort()
  })
})
