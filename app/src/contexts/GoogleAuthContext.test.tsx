// @vitest-environment jsdom
import { useEffect } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { googleClientManager } from '../lib/googleClientManager'
import { GoogleAuthProvider, useGoogleAuth } from './GoogleAuthContext'

const PKCE_STATE_KEY = 'runme/google-auth/pkce-state'
const PKCE_CODE_VERIFIER_KEY = 'runme/google-auth/pkce-code-verifier'
const PKCE_RETURN_TO_KEY = 'runme/google-auth/pkce-return-to'
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
})
