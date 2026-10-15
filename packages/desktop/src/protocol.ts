/** JSON-only messages cross the isolated preload boundary; no Electron APIs escape. */
export const channels = {
  catalog: 'runme:tool-catalog',
  request: 'runme:tool-request',
  response: 'runme:tool-response',
} as const

export type ToolDescriptor = {
  name: string
  title?: string
  description?: string
  inputSchema: { type: 'object'; [key: string]: unknown }
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown }
}

export type ToolRequest =
  | {
      id: string
      type: 'call'
      name: string
      arguments: Record<string, unknown>
    }
  | { id: string; type: 'cancel' }
  | { id: string; type: 'flush' }
export type ToolResponse = { id: string; result?: string; error?: string }

export interface DesktopBridge {
  publishTools(tools: ToolDescriptor[]): void
  onRequest(listener: (request: ToolRequest) => void): () => void
  respond(response: ToolResponse): void
}
