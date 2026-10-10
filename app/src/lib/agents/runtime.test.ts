import { afterEach, describe, expect, it, vi } from 'vitest'

import { callAgentsBridge } from './bridge'
import {
  createAgentsApi,
  mountAgentMonitor,
  resetAgentMonitors,
  resolveAgentMonitor,
} from './runtime'
import { AGENT_MONITOR_MIME, parseMonitorDescriptor } from './types'

afterEach(() => {
  resetAgentMonitors()
  localStorage.clear()
  vi.unstubAllGlobals()
})
describe('agents runtime', () => {
  it('sends and reads a page without mounting a widget, using the current vault key', async () => {
    const { webcrypto } = await import('node:crypto')
    const { keyVault } = await import('../keyvault/store')
    vi.stubGlobal('crypto', webcrypto)
    keyVault.refresh()
    await keyVault.unlock('messaging test passphrase', true)
    await keyVault.saveKey('messages', 'message-secret')
    const api = createAgentsApi()
    api.setKey(keyVault.getKey('messages'))
    const page = {
      data: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Reply' }],
        },
      ],
      has_more: true,
      last_id: 'msg_1',
    }
    const fetch = vi
      .fn<(url: string, options?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page)))
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    await api.sendMessage('sess/1', 'Some prompt\nwith whitespace  ', {
      idempotencyKey: 'request-1',
      signal,
    })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(
      'https://api.openai.com/v1/agents/sessions/sess%2F1/events'
    )
    expect(init?.signal).toBe(signal)
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer message-secret'
    )
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('request-1')
    expect(
      JSON.parse(init?.body as string).events[0].input[0].content[0].text
    ).toBe('Some prompt\nwith whitespace  ')
    await keyVault.saveKey('messages', 'rotated-message-secret', 'messages')
    expect(
      await api.listItems('sess/1', { limit: 25, after: 'a&b', signal })
    ).toEqual(page)
    expect(fetch.mock.calls[1][0]).toBe(
      'https://api.openai.com/v1/agents/sessions/sess%2F1/items?order=desc&limit=25&after=a%26b'
    )
    expect(
      new Headers(fetch.mock.calls[1][1]?.headers).get('Authorization')
    ).toBe('Bearer rotated-message-secret')
    expect(JSON.stringify(localStorage)).not.toContain('Some prompt')
    expect(JSON.stringify(localStorage)).not.toContain('Reply')
    keyVault.lock()
    await expect(api.sendMessage('sess/1', 'blocked')).rejects.toThrow(
      'Unlock Key Vault'
    )
    await expect(api.listItems('sess/1')).rejects.toThrow('Unlock Key Vault')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('uses fresh IDs for separate sends, keeps explicit retry IDs, and never retries automatically', async () => {
    const api = createAgentsApi()
    api.configure({ baseUrl: 'https://proxy.example/v1' })
    const fetch = vi
      .fn<(url: string, options?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new Error('Network failed'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    await api.sendMessage('sess_1', 'hello')
    await api.sendMessage('sess_1', 'hello')
    const first = new Headers(fetch.mock.calls[0][1]?.headers).get(
      'Idempotency-Key'
    )
    const second = new Headers(fetch.mock.calls[1][1]?.headers).get(
      'Idempotency-Key'
    )
    expect(first).toBeTruthy()
    expect(first).not.toBe(second)
    await expect(
      api.sendMessage('sess_1', 'hello', { idempotencyKey: 'stable' })
    ).rejects.toThrow('Network failed')
    expect(fetch).toHaveBeenCalledTimes(3)
    await api.sendMessage('sess_1', 'hello', { idempotencyKey: 'stable' })
    expect(
      new Headers(fetch.mock.calls[2][1]?.headers).get('Idempotency-Key')
    ).toBe('stable')
    expect(
      new Headers(fetch.mock.calls[3][1]?.headers).get('Idempotency-Key')
    ).toBe('stable')
  })
  it('validates messaging inputs before fetching and keeps the sandbox allowlist unchanged', async () => {
    const api = createAgentsApi()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(api.sendMessage('', 'hello')).rejects.toThrow('sessionId')
    await expect(api.sendMessage('sess_1', '  ')).rejects.toThrow(
      'Message text'
    )
    await expect(
      api.sendMessage('sess_1', 'hello', { idempotencyKey: '' })
    ).rejects.toThrow('idempotencyKey')
    await expect(api.listItems('')).rejects.toThrow('sessionId')
    for (const limit of [0, 101, 1.5])
      await expect(api.listItems('sess_1', { limit })).rejects.toThrow('limit')
    await expect(api.listItems('sess_1', { after: '' })).rejects.toThrow(
      'after'
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(() =>
      callAgentsBridge(api, 'agents.sendMessage', ['sess_1', 'hello'])
    ).toThrow('Unsupported')
    expect(() => callAgentsBridge(api, 'agents.listItems', ['sess_1'])).toThrow(
      'Unsupported'
    )
  })
  it('creates with fresh vault auth without displaying or saving session data', async () => {
    const { webcrypto } = await import('node:crypto')
    const { keyVault } = await import('../keyvault/store')
    vi.stubGlobal('crypto', webcrypto)
    keyVault.refresh()
    await keyVault.unlock('session creation test passphrase', true)
    await keyVault.saveKey('test-project', 'first-secret')
    const display = vi.fn()
    const api = createAgentsApi(display)
    api.setKey(keyVault.getKey('test-project'))
    const result = {
      id: 'sess_created',
      environment: {
        id: 'env_created',
        remote_url: 'https://api.openai.com/remote',
      },
    }
    const fetch = vi.fn<
      (url: string, options?: RequestInit) => Promise<Response>
    >(async () => new Response(JSON.stringify(result)))
    vi.stubGlobal('fetch', fetch)
    const parameters = {
      agent_id: 'agent_test',
      environment: { type: 'self_hosted' },
    }
    const signal = new AbortController().signal
    expect(await api.createSession(parameters, { signal })).toEqual(result)
    expect(fetch.mock.calls[0][1]?.signal).toBe(signal)
    expect(
      new Headers(fetch.mock.calls[0][1]?.headers).get('Authorization')
    ).toBe('Bearer first-secret')
    await keyVault.saveKey('test-project', 'rotated-secret', 'test-project')
    await api.createSession(parameters)
    expect(
      new Headers(fetch.mock.calls[1][1]?.headers).get('Authorization')
    ).toBe('Bearer rotated-secret')
    expect(display).not.toHaveBeenCalled()
    expect(JSON.stringify(localStorage)).not.toContain('sess_created')
    expect(JSON.stringify(localStorage)).not.toContain('first-secret')
    keyVault.lock()
    await expect(api.createSession(parameters)).rejects.toThrow(
      'Unlock Key Vault'
    )
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(() =>
      callAgentsBridge(api, 'agents.createSession', [parameters])
    ).toThrow('Unsupported')
  })
  it('survives the StrictMode remount probe and requires explicit connection after closing', async () => {
    const api = createAgentsApi(() => {})
    const monitor = resolveAgentMonitor(api.monitor('sess_test'))
    const connect = vi.spyOn(monitor, 'connect').mockResolvedValue()
    const pause = vi.spyOn(monitor, 'pause')
    const first = mountAgentMonitor(monitor)
    first()
    const second = mountAgentMonitor(monitor)
    await Promise.resolve()
    expect(pause).not.toHaveBeenCalled()
    second()
    await Promise.resolve()
    expect(pause).toHaveBeenCalledTimes(1)
    connect.mockClear()
    const reopened = mountAgentMonitor(monitor)
    expect(connect).not.toHaveBeenCalled()
    reopened()
    await Promise.resolve()
  })
  it('emits only a serializable descriptor and never credential configuration', () => {
    const outputs: string[] = []
    const api = createAgentsApi((mime, value) => {
      expect(mime).toBe(AGENT_MONITOR_MIME)
      outputs.push(value)
    })
    api.configure({
      baseUrl: 'https://api.openai.com/v1',
      getHeaders: () => ({ Authorization: 'secret' }),
    })
    const widget = api.monitor('sess_test')
    expect(parseMonitorDescriptor(outputs[0])).toEqual(widget)
    expect(outputs[0]).not.toContain('secret')
    expect(Object.keys(widget)).toEqual([
      'version',
      'id',
      'sessionId',
      'pageSize',
    ])
    expect(api.get(widget.id).connection).toBe('disconnected')
    callAgentsBridge(api, 'agents.pause', [widget.id])
    expect(api.get(widget.id).connection).toBe('paused')
  })
  it('rejects invalid page sizes and disallows sandbox configuration', () => {
    const api = createAgentsApi(() => {})
    expect(() => api.monitor('s', { pageSize: 101 })).toThrow('pageSize')
    expect(() => api.monitor('')).toThrow('sessionId')
    expect(() => callAgentsBridge(api, 'agents.configure', [])).toThrow(
      'Unsupported'
    )
    expect(() => createAgentsApi().monitor('s')).toThrow('notebook JS cell')
  })
})

it('restores a named vault key after reload and resolves rotation on resume', async () => {
  const { webcrypto } = await import('node:crypto')
  const { keyVault } = await import('../keyvault/store')
  vi.stubGlobal('crypto', webcrypto)
  localStorage.clear()
  keyVault.refresh()
  await keyVault.unlock('reload test passphrase', true)
  await keyVault.saveKey('olympus', 'original-secret')
  const api = createAgentsApi(() => {})
  api.setKey(keyVault.getKey('olympus'))
  const descriptor = api.monitor('sess_reload')
  resetAgentMonitors()
  keyVault.lock()
  const restored = resolveAgentMonitor(descriptor)
  const fetchMock = vi.fn<
    (url: string, options?: RequestInit) => Promise<Response>
  >(async () => new Response('{}', { status: 401 }))
  vi.stubGlobal('fetch', fetchMock)
  await restored.connect()
  expect(restored.getSnapshot().error).toContain('Unlock Key Vault')
  expect(fetchMock).not.toHaveBeenCalled()
  await keyVault.unlock('reload test passphrase')
  await restored.connect()
  expect(
    new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')
  ).toBe('Bearer original-secret')
  await keyVault.saveKey('olympus', 'rotated-secret', 'olympus')
  expect(restored.getSnapshot().connection).toBe('paused')
  await restored.connect()
  expect(
    new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization')
  ).toBe('Bearer rotated-secret')
  await keyVault.deleteKey('olympus')
  await restored.connect()
  expect(restored.getSnapshot().error).toContain('Key "olympus" is missing')
  expect(fetchMock).toHaveBeenCalledTimes(2)
  keyVault.lock()
})

it('requires reconfiguration for a saved custom connection instead of using a vault key', async () => {
  const api = createAgentsApi(() => {})
  api.configure({ baseUrl: 'https://proxy.example/v1' })
  const descriptor = api.monitor('sess_proxy')
  resetAgentMonitors()
  const restored = resolveAgentMonitor(descriptor)
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await restored.connect()
  expect(restored.getSnapshot().error).toContain('agents.configure')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('uses vault keys only for OpenAI requests and stops monitors when the vault locks', async () => {
  const { webcrypto } = await import('node:crypto')
  const { keyVault, resolveKeyReference } = await import('../keyvault/store')
  vi.stubGlobal('crypto', webcrypto)
  localStorage.clear()
  keyVault.refresh()
  await keyVault.unlock('a long test passphrase', true)
  await keyVault.saveKey('openai-api', 'runtime-secret')
  const outputs: string[] = []
  const api = createAgentsApi((_mime, value) => outputs.push(value))
  expect(api.setKey(keyVault.getKey('openai-api'))).toEqual({
    configured: true,
  })
  const fetchMock = vi.fn<
    (url: string, options?: RequestInit) => Promise<Response>
  >(async () => new Response('{}', { status: 401 }))
  vi.stubGlobal('fetch', fetchMock)
  const descriptor = api.monitor('sess_test')
  await api.resume(descriptor.id)
  expect(fetchMock).toHaveBeenCalled()
  const [url, options] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ]
  expect(url).toBe(
    'https://api.openai.com/v1/agents/sessions/sess_test/events?stream=true'
  )
  expect(new Headers(options.headers).get('Authorization')).toBe(
    'Bearer runtime-secret'
  )
  expect(outputs.join('')).not.toContain('runtime-secret')
  expect(JSON.stringify(api.get(descriptor.id))).not.toContain('runtime-secret')
  keyVault.lock()
  expect(api.get(descriptor.id).connection).toBe('paused')
  expect(() => keyVault.getKey('openai-api')).toThrow('Unlock')
  expect(() =>
    callAgentsBridge(api, 'agents.setKey', [{ name: 'openai-api' }])
  ).toThrow('Unsupported')
  expect(() =>
    resolveKeyReference({
      name: 'openai-api',
      toJSON: () => ({ name: 'openai-api' }),
    })
  ).toThrow('getKey')
  vi.unstubAllGlobals()
})
