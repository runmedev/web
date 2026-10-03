import { afterEach, describe, expect, it, vi } from 'vitest'

import { callAgentsBridge } from './bridge'
import {
  createAgentsApi,
  mountAgentMonitor,
  resetAgentMonitors,
  resolveAgentMonitor,
} from './runtime'
import { AGENT_MONITOR_MIME, parseMonitorDescriptor } from './types'

afterEach(resetAgentMonitors)
describe('agents runtime', () => {
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
  const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }))
  vi.stubGlobal('fetch', fetchMock)
  const descriptor = api.monitor('sess_test')
  await api.resume(descriptor.id)
  expect(fetchMock).toHaveBeenCalled()
  const [url, options] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ]
  expect(url).toBe('https://api.openai.com/v1/agents/sessions/sess_test/events?stream=true')
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
