import { exportPKCS8, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRunnerAuthForTests } from '../../auth/runnerAuth'
import { resetWorkloadIdentityForTests } from '../../auth/workloadIdentity'
import { configureRunner, runnerAuthTools } from './runnerAuthTools'

const update = vi.hoisted(() => vi.fn())
vi.mock('./runnersManager', () => ({ getRunnersManager: () => ({ update }) }))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetRunnerAuthForTests()
  resetWorkloadIdentityForTests()
  update.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('runner authentication tools', () => {
  it('configures direct metadata through the shared tool and returns no token', async () => {
    const input = {
      authFlow: 'workload_identity',
      provider: 'gke_metadata',
      tokenMode: 'metadata_direct',
      expectedServiceAccountEmail: 'runme@project.iam.gserviceaccount.com',
      scopes: ['https://www.googleapis.com/auth/drive'],
    }
    const tool = runnerAuthTools().find(
      (tool) => tool.name === 'configureGoogleWorkloadIdentity'
    )!
    const mint = vi.fn().mockResolvedValue({
      accessToken: 'secret-fixture',
      tokenType: 'Bearer',
      serviceAccountEmail: input.expectedServiceAccountEmail,
      scopes: input.scopes,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    })
    const host = window as Window & { runmeDesktop?: unknown }
    host.runmeDesktop = { googleAccessToken: mint }
    try {
      expect(JSON.parse(await tool.execute(input))).toEqual({
        configured: true,
        serviceAccountEmail: input.expectedServiceAccountEmail,
      })
      expect(mint).toHaveBeenCalledWith({
        expectedServiceAccountEmail: input.expectedServiceAccountEmail,
        scopes: input.scopes,
        tokenMode: 'metadata_direct',
        lifetimeSeconds: undefined,
        forceRefresh: false,
      })
      await expect(
        tool.execute({ ...input, lifetimeSeconds: 900 })
      ).rejects.toThrow()
      expect(mint).toHaveBeenCalledTimes(1)
      delete host.runmeDesktop
      await expect(tool.execute(input)).rejects.toThrow(
        'requires Runme Desktop'
      )
    } finally {
      delete host.runmeDesktop
      resetWorkloadIdentityForTests()
    }
  })

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
