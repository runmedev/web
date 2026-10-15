import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { startAssetServer, startMcpServer } from './server.js'
import { ToolBridge } from './toolBridge.js'

test('MCP authenticates, discovers the live registry, and propagates calls/errors', async () => {
  const bridge = new ToolBridge((request) => {
    if (request.type === 'call')
      bridge.respond({
        id: request.id,
        result: JSON.stringify(request.arguments),
      })
  })
  const catalog = [
    {
      name: 'echo',
      title: 'Echo tool',
      description: 'Echo the supplied value.',
      inputSchema: {
        type: 'object' as const,
        properties: { value: { type: 'number' } },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    },
  ]
  bridge.setTools(catalog)
  const http = await startMcpServer(bridge, 'a'.repeat(64), 0)
  const url = new URL(
    `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`
  )
  const client = new Client({ name: 'test', version: '1' })
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 403)
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${'a'.repeat(64)}`,
            Origin: 'https://untrusted.example',
          },
        })
      ).status,
      403
    )
    const reboundStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          url,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${'a'.repeat(64)}`,
              Host: 'attacker.example',
            },
          },
          (res) => {
            res.resume()
            resolve(res.statusCode)
          }
        )
        req.on('error', reject)
        req.end()
      }
    )
    assert.equal(reboundStatus, 403)
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${'a'.repeat(64)}` } },
      })
    )
    const wire = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${'a'.repeat(64)}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/list',
        params: {},
      }),
    })
    assert.deepEqual((await wire.json()).result.tools, catalog)
    // The SDK client drops annotations outside its own MCP schema. The wire
    // catalog above still retains them for clients supporting WebMCP hints.
    assert.deepEqual(
      (await client.listTools()).tools,
      catalog.map((tool) => ({
        ...tool,
        annotations: { readOnlyHint: true },
      }))
    )
    const result = await client.callTool({
      name: 'echo',
      arguments: { value: 42 },
    })
    assert.deepEqual(result.content, [{ type: 'text', text: '{"value":42}' }])
    assert.equal((await client.callTool({ name: 'missing' })).isError, true)
    bridge.reset()
    await assert.rejects(client.listTools(), /loading/)
  } finally {
    await client.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
})

test('renderer reload rejects pending writes and cancellation reaches the renderer', async () => {
  const sent: unknown[] = []
  const bridge = new ToolBridge((request) => sent.push(request))
  bridge.setTools([{ name: 'write', inputSchema: { type: 'object' } }])
  const pending = bridge.call('write', {})
  bridge.reset()
  await assert.rejects(pending, /outcome may be unknown/)
  bridge.setTools([{ name: 'write', inputSchema: { type: 'object' } }])
  const controller = new AbortController()
  const cancelled = bridge.call('write', {}, controller.signal)
  controller.abort()
  await assert.rejects(cancelled, /cancelled/)
  assert.equal((sent.at(-1) as { type: string }).type, 'cancel')
})

test('shutdown waits for a successful renderer flush and rejects new calls', async () => {
  const sent: Array<{ id: string; type: string }> = []
  const bridge = new ToolBridge((request) => sent.push(request))
  bridge.setTools([
    {
      name: 'write',
      inputSchema: {
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
    },
  ])
  await assert.rejects(
    bridge.call('write', { value: 123 }),
    /Invalid arguments/
  )
  assert.equal(sent.length, 0)
  const flushing = bridge.flush()
  await assert.rejects(bridge.call('write', { value: 'test' }), /closing/)
  assert.equal(sent[0].type, 'flush')
  bridge.respond({ id: sent[0].id, error: 'Storage unavailable' })
  await assert.rejects(flushing, /Storage unavailable/)
  const retry = bridge.flush()
  bridge.respond({ id: sent[1].id, result: 'flushed' })
  await retry
})

test('asset server supports SPA paths but never serves files outside the bundle', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runme-assets-'))
  await mkdir(path.join(directory, 'web'))
  await writeFile(path.join(directory, 'web/index.html'), '<h1>Runme</h1>')
  await writeFile(path.join(directory, 'secret'), 'private')
  await symlink(
    path.join(directory, 'secret'),
    path.join(directory, 'web/leak.txt')
  )
  const server = await startAssetServer(
    path.join(directory, 'web'),
    0,
    'agent: {}'
  )
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    assert.equal(await (await fetch(url)).text(), '<h1>Runme</h1>')
    assert.equal(
      await (
        await fetch(`${url}/notebook`, { headers: { Accept: 'text/html' } })
      ).text(),
      '<h1>Runme</h1>'
    )
    assert.equal((await fetch(`${url}/missing.js`)).status, 404)
    assert.equal((await fetch(`${url}/leak.txt`)).status, 404)
    assert.equal((await fetch(`${url}/%2e%2e%2fsecret`)).status, 404)
    assert.equal(
      await (await fetch(`${url}/configs/app-configs.yaml`)).text(),
      'agent: {}'
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true })
  }
})
