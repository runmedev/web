import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { timingSafeEqual } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { type IncomingMessage, createServer } from 'node:http'
import path from 'node:path'

import type { ToolBridge } from './toolBridge.js'

/** A token is required even on loopback: local web pages must not gain notebook execution. */
export function authorize(
  req: IncomingMessage,
  port: number,
  token: string
): boolean {
  if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin)
    return false
  const actual = Buffer.from(req.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Starts stateless MCP HTTP sessions over a shared, persistent renderer's app state. */
export async function startMcpServer(
  bridge: ToolBridge,
  token: string,
  port: number
) {
  const http = createServer(async (req, res) => {
    const actualPort = (http.address() as { port: number }).port
    if (!authorize(req, actualPort, token)) {
      res.writeHead(403).end()
      return
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    const server = new Server(
      { name: 'runme-desktop', version: '0.1.0' },
      {
        capabilities: { tools: {} },
        instructions:
          'Runme tools operate on the live application. Call readInstructionsForAIAgents first. Use ExecuteCode and its operation polling/cancellation tools for notebook workflows. After reload or disconnection, list tools again and inspect state before retrying mutations.',
      }
    )
    const disconnected = new AbortController()
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!bridge.tools.length)
        throw new Error('Runme is loading. Retry tool discovery shortly.')
      return { tools: bridge.tools }
    })
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        const text = await bridge.call(
          request.params.name,
          request.params.arguments ?? {},
          AbortSignal.any([extra.signal, disconnected.signal])
        )
        return { content: [{ type: 'text', text }] }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: String(error) }],
        }
      }
    })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      disconnected.abort()
      void server.close()
    })
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) {
          res.writeHead(413).end()
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400).end('Invalid JSON')
        return
      }
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch {
      if (!res.headersSent) res.writeHead(500).end('MCP request failed')
      else res.end()
      await server.close()
    }
  })
  await listen(http, port)
  return http
}

const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
}

/** Serves only packaged assets, preserving Vite's root URLs and a stable IndexedDB origin. */
export async function startAssetServer(
  root: string,
  port: number,
  config?: string
) {
  const base = await realpath(root)
  const http = createServer(async (req, res) => {
    const host = `127.0.0.1:${(http.address() as { port: number }).port}`
    if (req.headers.host !== host) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    try {
      const pathname = decodeURIComponent(
        new URL(req.url ?? '/', `http://${host}`).pathname
      )
      if (pathname === '/configs/app-configs.yaml' && config) {
        res.writeHead(200, {
          'Content-Type': 'application/yaml',
          'Cache-Control': 'no-store',
        })
        res.end(req.method === 'HEAD' ? undefined : config)
        return
      }
      if (pathname.split('/').some((part) => part.startsWith('.'))) {
        res.writeHead(404).end()
        return
      }
      let file = path.resolve(
        base,
        `.${pathname === '/' ? '/index.html' : pathname}`
      )
      if (!file.startsWith(base + path.sep)) {
        res.writeHead(404).end()
        return
      }
      try {
        if (!(await stat(file)).isFile()) throw new Error('Not a file')
      } catch {
        if (
          path.extname(pathname) ||
          !req.headers.accept?.includes('text/html')
        ) {
          res.writeHead(404).end()
          return
        }
        file = path.join(base, 'index.html')
      }
      file = await realpath(file)
      if (!file.startsWith(base + path.sep)) {
        res.writeHead(404).end()
        return
      }
      const body = await readFile(file)
      res.writeHead(200, {
        'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch {
      res.writeHead(404).end()
    }
  })
  await listen(http, port)
  return http
}

/** Bind only IPv4 loopback. Port zero is useful for isolated integration tests. */
function listen(
  server: ReturnType<typeof createServer>,
  port: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}
