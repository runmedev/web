import { describe, expect, it, vi } from 'vitest'

import type {
  DesktopBridge,
  ToolRequest,
  ToolResponse,
} from '../../../../packages/desktop/src/protocol'
import { createDesktopToolContext } from './desktopTools'

describe('desktop tool adapter', () => {
  it('drains cancelled work before flushing and blocks new calls during shutdown', async () => {
    let listener!: (request: ToolRequest) => void
    let finish!: () => void
    let edited = false
    const respond = vi.fn()
    const flush = vi.fn(async () => {
      // Model a late write from a handler that cannot cancel an in-flight save.
      expect(edited).toBe(true)
    })
    const execute = vi.fn(async (_args, options) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      expect(options.signal.aborted).toBe(true)
      edited = true
      return 'saved'
    })
    const context = createDesktopToolContext(
      {
        publishTools: () => {},
        onRequest: (handler) => {
          listener = handler
          return () => {}
        },
        respond,
      },
      flush
    )
    context.registerTool({ name: 'write', inputSchema: {}, execute })
    listener({ type: 'call', id: 'write', name: 'write', arguments: {} })
    await Promise.resolve()
    listener({ type: 'cancel', id: 'write' })
    listener({ type: 'flush', id: 'flush' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(flush).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
    listener({ type: 'call', id: 'late', name: 'write', arguments: {} })
    expect(respond).toHaveBeenCalledWith({
      id: 'late',
      error: 'Runme is saving and closing',
    })
    expect(execute).toHaveBeenCalledTimes(1)
    finish()
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({ id: 'flush', result: 'flushed' })
    )
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('propagates save failures and permits recovery and a later flush', async () => {
    let listener!: (request: ToolRequest) => void
    const respond = vi.fn()
    const flush = vi
      .fn()
      .mockRejectedValueOnce(new Error('Storage unavailable'))
      .mockResolvedValue(undefined)
    const context = createDesktopToolContext(
      {
        publishTools: () => {},
        onRequest: (handler) => {
          listener = handler
          return () => {}
        },
        respond,
      },
      flush
    )
    context.registerTool({
      name: 'recover',
      inputSchema: {},
      execute: () => 'recovered',
    })
    listener({ type: 'flush', id: 'first' })
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({
        id: 'first',
        error: 'Error: Storage unavailable',
      })
    )
    listener({ type: 'call', id: 'recovery', name: 'recover', arguments: {} })
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({
        id: 'recovery',
        result: 'recovered',
      })
    )
    listener({ type: 'flush', id: 'retry' })
    await vi.waitFor(() =>
      expect(respond).toHaveBeenCalledWith({ id: 'retry', result: 'flushed' })
    )
  })

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
