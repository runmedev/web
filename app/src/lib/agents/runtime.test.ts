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
