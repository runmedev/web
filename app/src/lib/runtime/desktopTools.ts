import type {
  DesktopBridge,
  ToolDescriptor,
  ToolRequest,
} from '../../../../packages/desktop/src/protocol'

export type ToolExecuteOptionsLike = {
  signal?: AbortSignal
  requestUserInteraction?: (
    callback: () => Promise<unknown> | unknown
  ) => Promise<unknown>
}
export type RegisteredAppTool = Omit<ToolDescriptor, 'inputSchema'> & {
  inputSchema: Record<string, unknown>
  execute: (
    input: Record<string, unknown>,
    options?: ToolExecuteOptionsLike
  ) => Promise<string> | string
}
export type ModelContextLike = {
  registerTool: (
    tool: RegisteredAppTool,
    options?: { signal?: AbortSignal }
  ) => Promise<undefined> | undefined
}

/** Adapts the existing app tools to Electron without requiring native WebMCP.
 * The registration host's AbortSignal owns the registry lifetime, just as in a browser.
 */
export function createDesktopToolContext(
  bridge: DesktopBridge,
  flush: () => Promise<void> = async () => {}
): ModelContextLike {
  const tools = new Map<string, RegisteredAppTool>()
  const calls = new Map<string, AbortController>()
  let unsubscribe: (() => void) | undefined
  const publish = () =>
    bridge.publishTools(
      [...tools.values()].map(
        ({ name, title, description, inputSchema, annotations }) =>
          ({
            name,
            title,
            description,
            inputSchema,
            annotations,
          }) as ToolDescriptor
      )
    )
  const handleRequest = (request: ToolRequest) => {
    if (request.type === 'flush') {
      void flush()
        .then(() => bridge.respond({ id: request.id, result: 'flushed' }))
        .catch((error: unknown) =>
          bridge.respond({ id: request.id, error: String(error) })
        )
      return
    }
    if (request.type === 'cancel') {
      calls.get(request.id)?.abort()
      return
    }
    const tool = tools.get(request.name)
    if (!tool) {
      bridge.respond({ id: request.id, error: `Unknown tool: ${request.name}` })
      return
    }
    const controller = new AbortController()
    calls.set(request.id, controller)
    void Promise.resolve()
      .then(() =>
        tool.execute(request.arguments, { signal: controller.signal })
      )
      .then((result) => bridge.respond({ id: request.id, result }))
      .catch((error: unknown) =>
        bridge.respond({ id: request.id, error: String(error) })
      )
      .finally(() => calls.delete(request.id))
  }
  return {
    registerTool(tool, options) {
      if (options?.signal?.aborted) return
      if (tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`)
      unsubscribe ??= bridge.onRequest(handleRequest)
      tools.set(tool.name, tool)
      publish()
      options?.signal?.addEventListener(
        'abort',
        () => {
          tools.delete(tool.name)
          publish()
          if (tools.size === 0) {
            unsubscribe?.()
            unsubscribe = undefined
            for (const call of calls.values()) call.abort()
          }
        },
        { once: true }
      )
      return undefined
    },
  }
}

/** Only Electron's isolated preload installs this bridge; normal web builds are unchanged. */
export function getDesktopToolContext(): ModelContextLike | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as Window & { runmeDesktop?: DesktopBridge })
    .runmeDesktop
  return bridge
    ? createDesktopToolContext(bridge, async () => {
        const { getNotebookDataController } = await import(
          '../notebookDataController'
        )
        const controller = getNotebookDataController()
        await Promise.all(
          controller
            .getSnapshot()
            .openNotebooks.map((entry) =>
              controller.getNotebookData(entry.uri)?.flushPendingPersist()
            )
        )
      })
    : null
}
