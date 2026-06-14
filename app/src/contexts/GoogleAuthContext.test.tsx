// @vitest-environment jsdom
import { useEffect } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { googleClientManager } from '../lib/googleClientManager'
import { GoogleAuthProvider, useGoogleAuth } from './GoogleAuthContext'

const PKCE_STATE_KEY = 'runme/google-auth/pkce-state'
const PKCE_CODE_VERIFIER_KEY = 'runme/google-auth/pkce-code-verifier'
const PKCE_RETURN_TO_KEY = 'runme/google-auth/pkce-return-to'
const PKCE_ERROR_KEY = 'runme/google-auth/pkce-error'
const IMPLICIT_PROMPT_MODE_KEY = 'runme/google-auth/implicit-prompt-mode'
const AUTH_HANDOFF_MODE_KEY = 'runme/google-auth/handoff-mode'
const STORAGE_KEY = 'runme/google-auth/token'

function CaptureAuth(props: {
  onReady: (auth: ReturnType<typeof useGoogleAuth>) => void
}) {
  const { onReady } = props
  const auth = useGoogleAuth()
  useEffect(() => {
    onReady(auth)
  }, [auth, onReady])
  return null
}

async function renderWithGoogleAuthProvider() {
  let captured: ReturnType<typeof useGoogleAuth> | null = null
  render(
    <GoogleAuthProvider>
      <CaptureAuth
        onReady={(auth) => {
          captured = auth
        }}
      />
    </GoogleAuthProvider>
  )
  await waitFor(() => {
    expect(captured).not.toBeNull()
  })
  return captured!
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return globalThis.btoa(binary)
}

async function generatePrivateKeyPem(): Promise<string> {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )
  const pkcs8 = await globalThis.crypto.subtle.exportKey(
    'pkcs8',
    keyPair.privateKey
  )
  const base64 = bytesToBase64(new Uint8Array(pkcs8))
  const lines = base64.match(/.{1,64}/g) ?? []
  return [
    '-----BEGIN PRIVATE KEY-----',
    ...lines,
    '-----END PRIVATE KEY-----',
  ].join('\n')
}

describe('GoogleAuthProvider implicit redirect flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.history.replaceState(null, '', '/')
    googleClientManager.setOAuthClient({
      clientId: 'test-client.apps.googleusercontent.com',
      authFlow: 'implicit',
      authUxMode: 'popup',
    })
  })

  it('starts implicit redirect flow when authFlow=implicit and authUxMode=redirect', async () => {
    googleClientManager.setOAuthClient({
      authFlow: 'implicit',
      authUxMode: 'redirect',
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const auth = await renderWithGoogleAuthProvider()

    await expect(auth.ensureAccessToken()).rejects.toThrow()

    expect(window.localStorage.getItem(PKCE_STATE_KEY)).toBeTruthy()
    expect(window.localStorage.getItem(PKCE_RETURN_TO_KEY)).toBe('/')
    expect(window.localStorage.getItem(IMPLICIT_PROMPT_MODE_KEY)).toBe('none')
    // Implicit redirect should not mint a PKCE verifier.
    expect(window.localStorage.getItem(PKCE_CODE_VERIFIER_KEY)).toBeNull()
  })

  it('starts implicit auth in a new tab when authUxMode=new_tab', async () => {
    googleClientManager.setOAuthClient({
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(window as unknown as Window)
    const auth = await renderWithGoogleAuthProvider()

    await expect(auth.ensureAccessToken()).rejects.toThrow()

    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openSpy.mock.calls[0]?.[1]).toBe('_blank')
    expect(window.localStorage.getItem(PKCE_STATE_KEY)).toBeTruthy()
    expect(window.localStorage.getItem(PKCE_RETURN_TO_KEY)).toBe('/')
    expect(window.localStorage.getItem(IMPLICIT_PROMPT_MODE_KEY)).toBe('none')
    expect(window.localStorage.getItem(PKCE_CODE_VERIFIER_KEY)).toBeNull()
  })

  it('starts a fresh implicit auth flow and replaces stale handoff state', async () => {
    googleClientManager.setOAuthClient({
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
    window.localStorage.setItem(PKCE_STATE_KEY, 'stale-state')
    window.localStorage.setItem(PKCE_CODE_VERIFIER_KEY, 'stale-verifier')
    window.localStorage.setItem(PKCE_RETURN_TO_KEY, '/stale')
    window.localStorage.setItem(IMPLICIT_PROMPT_MODE_KEY, 'consent')
    window.localStorage.setItem(AUTH_HANDOFF_MODE_KEY, 'new_tab')
    window.sessionStorage.setItem(PKCE_ERROR_KEY, 'stale-error')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(window as unknown as Window)
    const auth = await renderWithGoogleAuthProvider()

    await expect(auth.startGoogleDriveOAuth()).resolves.toMatchObject({
      status: 'started',
      authFlow: 'implicit',
      mode: 'new_tab',
    })

    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(PKCE_STATE_KEY)).toBeTruthy()
    expect(window.localStorage.getItem(PKCE_STATE_KEY)).not.toBe('stale-state')
    expect(window.localStorage.getItem(PKCE_CODE_VERIFIER_KEY)).toBeNull()
    expect(window.localStorage.getItem(PKCE_RETURN_TO_KEY)).toBe('/')
    expect(window.localStorage.getItem(IMPLICIT_PROMPT_MODE_KEY)).toBe('none')
    expect(window.localStorage.getItem(AUTH_HANDOFF_MODE_KEY)).toBe('new_tab')
    expect(window.sessionStorage.getItem(PKCE_ERROR_KEY)).toBeNull()
  })

  it('does not relaunch new-tab auth while a handoff is already in progress', async () => {
    googleClientManager.setOAuthClient({
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(window as unknown as Window)
    const auth = await renderWithGoogleAuthProvider()

    await expect(auth.ensureAccessToken()).rejects.toThrow()
    const initialState = window.localStorage.getItem(PKCE_STATE_KEY)

    await expect(auth.ensureAccessToken()).rejects.toThrow()

    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(PKCE_STATE_KEY)).toBe(initialState)
    expect(window.localStorage.getItem(PKCE_RETURN_TO_KEY)).toBe('/')
    expect(window.localStorage.getItem(IMPLICIT_PROMPT_MODE_KEY)).toBe('none')
    expect(window.localStorage.getItem(AUTH_HANDOFF_MODE_KEY)).toBe('new_tab')
  })

  it('syncs stored tokens from another tab via the storage event', async () => {
    const auth = await renderWithGoogleAuthProvider()
    const tokenInfo = {
      token: 'test-access-token',
      expiresAt: Date.now() + 30 * 60 * 1000,
    }
    await act(async () => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tokenInfo))
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEY,
          newValue: JSON.stringify(tokenInfo),
          storageArea: window.localStorage,
        })
      )
    })

    await expect(auth.ensureAccessToken({ interactive: false })).resolves.toBe(
      'test-access-token'
    )
  })

  it('does not reuse a cached OAuth token for service account auth', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: 'prior-oauth-token',
        expiresAt: Date.now() + 30 * 60 * 1000,
        authFlow: 'implicit',
      })
    )
    googleClientManager.setOAuthClient({
      clientId: '',
      authFlow: 'service_account',
      authUxMode: 'new_tab',
      serviceAccount: {
        clientEmail: 'runme-drive-test@example.iam.gserviceaccount.com',
        privateKey: await generatePrivateKeyPem(),
      },
    })
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'service-account-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const auth = await renderWithGoogleAuthProvider()

    let token = ''
    await act(async () => {
      token = await auth.ensureAccessToken({ interactive: false })
    })

    expect(token).toBe('service-account-token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    ).toMatchObject({
      token: 'service-account-token',
      authFlow: 'service_account',
    })
  })

  it('mints a service account access token without interactive OAuth', async () => {
    googleClientManager.setOAuthClient({
      clientId: '',
      authFlow: 'service_account',
      authUxMode: 'new_tab',
      serviceAccount: {
        clientEmail: 'runme-drive-test@example.iam.gserviceaccount.com',
        privateKey: await generatePrivateKeyPem(),
      },
    })
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'service-account-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const openSpy = vi.spyOn(window, 'open')
    const auth = await renderWithGoogleAuthProvider()

    let token = ''
    await act(async () => {
      token = await auth.ensureAccessToken({ interactive: false })
    })

    expect(token).toBe('service-account-token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('authorizes service account Drive sessions without opening OAuth UI', async () => {
    googleClientManager.setOAuthClient({
      clientId: '',
      authFlow: 'service_account',
      authUxMode: 'new_tab',
      serviceAccount: {
        clientEmail: 'runme-drive-test@example.iam.gserviceaccount.com',
        privateKey: await generatePrivateKeyPem(),
      },
    })
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'service-account-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const openSpy = vi.spyOn(window, 'open')
    const auth = await renderWithGoogleAuthProvider()

    let result: Awaited<ReturnType<typeof auth.startGoogleDriveOAuth>> | null =
      null
    await act(async () => {
      result = await auth.startGoogleDriveOAuth()
    })

    expect(result).toMatchObject({
      status: 'authorized',
      authFlow: 'service_account',
      mode: 'new_tab',
      accessToken: 'service-account-token',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(openSpy).not.toHaveBeenCalled()
  })
})
