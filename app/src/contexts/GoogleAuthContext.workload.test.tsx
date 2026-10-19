// @vitest-environment jsdom
import type { DesktopBridge } from '../../../packages/desktop/src/protocol'
import { act, cleanup, render } from '@testing-library/react'
import { exportPKCS8, generateKeyPair } from 'jose'
import { afterEach, expect, it, vi } from 'vitest'

import {
  configureRunnerAuth,
  resetRunnerAuthForTests,
} from '../auth/runnerAuth'
import {
  configureGoogleWorkloadIdentity,
  resetWorkloadIdentityForTests,
} from '../auth/workloadIdentity'
import { GoogleAuthProvider, useGoogleAuth } from './GoogleAuthContext'

const desktopWindow = window as Window & { runmeDesktop?: DesktopBridge }

afterEach(() => {
  cleanup()
  delete desktopWindow.runmeDesktop
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
  resetRunnerAuthForTests()
  resetWorkloadIdentityForTests()
})

it.each(['runner', 'gke_metadata'] as const)(
  'keeps %s Drive sync renewable and respects explicit disconnect',
  async (provider) => {
    sessionStorage.clear()
    localStorage.clear()
    resetRunnerAuthForTests()
    resetWorkloadIdentityForTests()
    const pair = await generateKeyPair('ES256', { extractable: true })
    await configureRunnerAuth({
      runnerName: 'pod',
      runnerBaseUrl: 'https://localhost:9988',
      issuer: 'urn:runme:browser',
      audience: 'urn:runme:runner',
      subject: 'runme',
      keyId: 'test',
      privateKeyPkcs8Pem: await exportPKCS8(pair.privateKey),
    })
    const scopes = ['https://www.googleapis.com/auth/drive']
    const serviceAccountEmail = 'runme@project.iam.gserviceaccount.com'
    configureGoogleWorkloadIdentity({
      authFlow: 'workload_identity',
      provider,
      runnerName: 'pod',
      expectedServiceAccountEmail: serviceAccountEmail,
      scopes,
    })
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            accessToken: 'workload-token',
            tokenType: 'Bearer',
            serviceAccountEmail,
            scopes,
            expiresAt: new Date(Date.now() + 899000).toISOString(),
          })
        )
    )
    vi.stubGlobal('fetch', fetcher)
    const desktopMint = vi.fn(async () => ({
      accessToken: 'workload-token',
      tokenType: 'Bearer' as const,
      serviceAccountEmail,
      scopes,
      expiresAt: new Date(Date.now() + 899000).toISOString(),
    }))
    if (provider === 'gke_metadata') {
      desktopWindow.runmeDesktop = {
        googleAccessToken: desktopMint,
      } as unknown as NonNullable<typeof desktopWindow.runmeDesktop>
    }
    const credentialRequest = provider === 'runner' ? fetcher : desktopMint
    const popup = vi.spyOn(window, 'open')
    let auth!: ReturnType<typeof useGoogleAuth>
    function Capture() {
      auth = useGoogleAuth()
      return null
    }
    vi.useFakeTimers()
    render(
      <GoogleAuthProvider>
        <Capture />
      </GoogleAuthProvider>
    )
    await act(async () => {
      await auth.ensureAccessToken({ interactive: false })
    })
    expect(auth.driveCredentialStatus.connected).toBe(true)
    act(() => {
      vi.advanceTimersByTime(930000)
    })
    expect(auth.driveCredentialStatus.connected).toBe(false)
    expect(auth.isDriveSyncing).toBe(true)
    await act(async () => {
      await expect(
        auth.ensureAccessToken({ interactive: false })
      ).resolves.toBe('workload-token')
    })
    expect(credentialRequest).toHaveBeenCalledTimes(2)
    expect(popup).not.toHaveBeenCalled()
    await act(async () => {
      await auth.logoutGoogleDrive()
    })
    expect(auth.isDriveSyncing).toBe(false)
    expect(auth.driveCredentialStatus.connected).toBe(false)
    await expect(
      auth.ensureAccessToken({ interactive: false, forceRefresh: true })
    ).rejects.toThrow('disconnected')
    expect(credentialRequest).toHaveBeenCalledTimes(2)
    await act(async () => {
      await auth.startGoogleDriveOAuth()
    })
    expect(auth.isDriveSyncing).toBe(true)
    expect(credentialRequest).toHaveBeenCalledTimes(3)
    if (provider === 'gke_metadata') expect(fetcher).not.toHaveBeenCalled()
    popup.mockRestore()
  }
)
