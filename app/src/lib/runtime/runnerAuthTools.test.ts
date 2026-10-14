import { exportPKCS8, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRunnerAuthForTests } from '../../auth/runnerAuth'
import { configureRunner, runnerAuthTools } from './runnerAuthTools'

const update = vi.hoisted(() => vi.fn())
vi.mock('./runnersManager', () => ({ getRunnersManager: () => ({ update }) }))
vi.mock('../../auth/workloadIdentity', () => ({
  getWorkloadIdentityConfig: () => undefined,
}))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetRunnerAuthForTests()
  update.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('runner authentication tools', () => {
  it.each([
    ['http://localhost:9988', 'ws://localhost:9988/ws'],
    ['https://runner.example', 'wss://runner.example/ws'],
  ])(
    'registers the matching WebSocket transport for %s',
    async (runnerBaseUrl, endpoint) => {
      const pair = await generateKeyPair('ES256', { extractable: true })
      const privateKeyPkcs8Pem = await exportPKCS8(pair.privateKey)
      const status = await configureRunner({
        runnerName: 'test',
        runnerBaseUrl,
        issuer: 'test',
        audience: 'test',
        subject: 'runme',
        keyId: 'test',
        privateKeyPkcs8Pem,
      })
      expect(update).toHaveBeenCalledWith('test', endpoint)
      expect(status.configured).toBe(true)
      expect(JSON.stringify(status)).not.toContain('PRIVATE KEY')
      resetRunnerAuthForTests()
      const tool = runnerAuthTools().find(
        (tool) => tool.name === 'getRunnerAuthStatus'
      )!
      const result = await tool.execute({ runnerName: 'test' })
      expect(JSON.parse(result).configured).toBe(true)
      expect(result).not.toContain('PRIVATE KEY')
      const clear = runnerAuthTools().find(
        (tool) => tool.name === 'clearRunnerAuth'
      )!
      await clear.execute({ runnerName: 'test' })
      expect(localStorage.getItem('runme/runnerAuth/v2')).not.toContain(
        'PRIVATE KEY'
      )
    }
  )
})
