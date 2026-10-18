/** JSON-only messages cross the isolated preload boundary; no Electron APIs escape. */
export const channels = {
  catalog: 'runme:tool-catalog',
  request: 'runme:tool-request',
  response: 'runme:tool-response',
  googleToken: 'runme:google-token',
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
  googleAccessToken?(request: GoogleTokenRequest): Promise<GoogleTokenResult>
  publishTools(tools: ToolDescriptor[]): void
  onRequest(listener: (request: ToolRequest) => void): () => void
  respond(response: ToolResponse): void
}

export type GoogleTokenMode = 'iam_exchange' | 'metadata_direct'

export interface GoogleTokenRequest {
  tokenMode?: GoogleTokenMode
  expectedServiceAccountEmail: string
  scopes: string[]
  lifetimeSeconds?: number
  forceRefresh?: boolean
}

export interface GoogleTokenResult {
  accessToken: string
  tokenType: 'Bearer'
  expiresAt: string
  serviceAccountEmail: string
  scopes: string[]
}
