import { ToolSchema } from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { randomUUID } from 'node:crypto'

import type { ToolDescriptor, ToolRequest, ToolResponse } from './protocol.js'

/** Owns calls into the current renderer. Reload/crash rejects calls, never silently retries writes. */
export class ToolBridge {
  tools: ToolDescriptor[] = []
  private validator = new AjvJsonSchemaValidator()
  private closing = false
  private pending = new Map<
    string,
    { resolve: (value: string) => void; reject: (error: Error) => void }
  >()

  constructor(
    private send: (request: ToolRequest) => void,
    private timeoutMs = 120_000
  ) {}

  setTools(value: unknown) {
    if (!Array.isArray(value) || value.length > 256)
      throw new Error('Invalid tool catalog')
    const tools = value.map((tool) => ToolSchema.parse(tool))
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      throw new Error('Duplicate tools')
    this.tools = tools
  }

  respond(response: ToolResponse) {
    const pending = this.pending.get(response.id)
    if (!pending) return
    if (typeof response.error === 'string')
      pending.reject(new Error(response.error))
    else if (typeof response.result === 'string')
      pending.resolve(response.result)
    else pending.reject(new Error('Invalid tool response'))
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<string> {
    if (this.closing) throw new Error('Runme is saving and closing')
    const tool = this.tools.find((tool) => tool.name === name)
    if (!tool) throw new Error(`Unknown or unavailable tool: ${name}`)
    if (!this.validator.getValidator(tool.inputSchema)(args).valid)
      throw new Error(`Invalid arguments for ${name}`)
    return this.dispatch(
      { id: randomUUID(), type: 'call', name, arguments: args },
      signal
    )
  }

  /** Flush pending debounced notebook edits before terminating the renderer. */
  async flush() {
    if (this.pending.size)
      throw new Error(
        'Wait for active MCP calls to finish before closing Runme'
      )
    this.closing = true
    try {
      if (this.tools.length)
        await this.dispatch({ id: randomUUID(), type: 'flush' })
    } catch (error) {
      this.closing = false
      throw error
    }
  }

  private async dispatch(
    request: ToolRequest,
    signal?: AbortSignal
  ): Promise<string> {
    if (this.pending.size >= 32)
      throw new Error('Too many concurrent tool calls')
    if (signal?.aborted) throw new Error('Tool call cancelled')
    const id = request.id
    let timer: NodeJS.Timeout | undefined
    const cancel = () => {
      this.send({ id, type: 'cancel' })
      this.pending
        .get(id)
        ?.reject(
          new Error(
            'Tool call cancelled or timed out; inspect operation state before retrying writes'
          )
        )
    }
    try {
      return await new Promise<string>((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        timer = setTimeout(cancel, this.timeoutMs)
        signal?.addEventListener('abort', cancel, { once: true })
        this.send(request)
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      this.pending.delete(id)
    }
  }

  reset() {
    this.tools = []
    for (const pending of this.pending.values())
      pending.reject(
        new Error(
          'Runme renderer disconnected; execution outcome may be unknown'
        )
      )
    this.pending.clear()
  }
}
