import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { DesktopBridge } from '../../../packages/desktop/src/protocol'
import {
  configureGoogleWorkloadIdentity,
  getWorkloadIdentityAccessToken,
  getWorkloadIdentityStatus,
  resetWorkloadIdentityForTests,
} from './workloadIdentity'

const desktopWindow = window as Window & {
  runmeDesktop?: Partial<DesktopBridge>
}

const config = {
  authFlow: 'workload_identity' as const,
  provider: 'gke_metadata' as const,
  expectedServiceAccountEmail: 'runme@example.iam.gserviceaccount.com',
  scopes: ['https://www.googleapis.com/auth/drive'],
  lifetimeSeconds: 900,
}
const result = () => ({
  accessToken: 'desktop-google-secret',
  tokenType: 'Bearer' as const,
  serviceAccountEmail: config.expectedServiceAccountEmail,
  scopes: config.scopes,
  expiresAt: new Date(Date.now() + 900000).toISOString(),
})
beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  resetWorkloadIdentityForTests()
})
afterEach(() => {
  delete desktopWindow.runmeDesktop
  vi.unstubAllGlobals()
})

it('uses only desktop JS credentials, coalesces renewal, and does not persist tokens', async () => {
  const mint = vi.fn().mockImplementation(async () => result())
  desktopWindow.runmeDesktop = { googleAccessToken: mint }
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  configureGoogleWorkloadIdentity(config)
  expect(getWorkloadIdentityStatus()?.canRenew).toBe(true)
  expect(
    await Promise.all([
      getWorkloadIdentityAccessToken(),
      getWorkloadIdentityAccessToken(),
    ])
  ).toEqual(['desktop-google-secret', 'desktop-google-secret'])
  expect(mint).toHaveBeenCalledTimes(1)
  expect(fetch).not.toHaveBeenCalled()
  expect(
    JSON.stringify(localStorage) + JSON.stringify(sessionStorage)
  ).not.toContain('desktop-google-secret')
  await getWorkloadIdentityAccessToken(true)
  expect(mint).toHaveBeenLastCalledWith(
    expect.objectContaining({ forceRefresh: true })
  )
  expect(mint).toHaveBeenCalledTimes(2)
})

it('fails closed outside desktop and rejects stale or mismatched credentials', async () => {
  configureGoogleWorkloadIdentity(config)
  await expect(getWorkloadIdentityAccessToken()).rejects.toThrow(
    'selected provider'
  )
  let finish!: (value: ReturnType<typeof result>) => void
  desktopWindow.runmeDesktop = {
    googleAccessToken: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  }
  const pending = getWorkloadIdentityAccessToken()
  configureGoogleWorkloadIdentity({
    ...config,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  })
  finish(result())
  await expect(pending).rejects.toThrow('selected provider')
  expect(getWorkloadIdentityStatus()?.connected).toBe(false)
  desktopWindow.runmeDesktop = {
    googleAccessToken: async () => ({
      ...result(),
      serviceAccountEmail: 'wrong',
    }),
  }
  await expect(getWorkloadIdentityAccessToken()).rejects.toThrow(
    'selected provider'
  )
})
