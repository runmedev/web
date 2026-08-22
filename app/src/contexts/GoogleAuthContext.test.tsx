// @vitest-environment jsdom
import { useEffect } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getBrowserAdapter } from '../browserAdapter.client'
import {
  DEFAULT_APP_LOGIN_CONFIGURATION,
  saveAppLoginConfiguration,
} from '../auth/appLoginConfiguration'
import {
  IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY,
  mergeImpersonatedServiceAccountCredential,
} from '../auth/impersonatedServiceAccountCredentialStore'
import { googleClientManager } from '../lib/googleClientManager'
import {
  DRIVE_SCOPES,
  GoogleAuthProvider,
  useGoogleAuth,
} from './GoogleAuthContext'

const PKCE_STATE_KEY = 'runme/google-auth/pkce-state'
const PKCE_CODE_VERIFIER_KEY = 'runme/google-auth/pkce-code-verifier'
const PKCE_RETURN_TO_KEY = 'runme/google-auth/pkce-return-to'
const PKCE_ERROR_KEY = 'runme/google-auth/pkce-error'
const IMPLICIT_PROMPT_MODE_KEY = 'runme/google-auth/implicit-prompt-mode'
const AUTH_HANDOFF_MODE_KEY = 'runme/google-auth/handoff-mode'
const SELECT_ACCOUNT_NEXT_KEY = 'runme/google-auth/select-account-next'
const STORAGE_KEY = 'runme/google-auth/token'
const STORED_DRIVE_ACCOUNT_KEY = 'runme/google-auth/drive-account'
const IMPERSONATION_TRANSACTION_KEY =
  'runme/google-auth/impersonation-transaction'
const IMPERSONATION_RESULT_KEY = 'runme/google-auth/impersonation-result'
const DRIVE_ABOUT_URL =
  'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)'

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

function makeUnsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    globalThis
      .btoa(JSON.stringify(value))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
  return `${encode({ alg: 'none' })}.${encode(payload)}.`
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
    vi.unstubAllGlobals()
    window.localStorage.clear()
    getBrowserAdapter().logout()
    window.sessionStorage.clear()
    window.history.replaceState(null, '', '/')
    googleClientManager.setOAuthClient({
      clientId: 'test-client.apps.googleusercontent.com',
      authFlow: 'implicit',
      authUxMode: 'popup',
    })
    delete window.google
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            user: { emailAddress: 'jlewi@openai.com' },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      })
    )
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

  it('authorizes keyless service-account credentials for Drive and Runme', async () => {
    saveAppLoginConfiguration({
      ...DEFAULT_APP_LOGIN_CONFIGURATION,
      identitySharing: 'shared',
      mode: 'service_account',
      humanAccount: 'jeremy@lewi.us',
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
    })
    const idToken = makeUnsignedJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: 'runme@example.iam.gserviceaccount.com',
    })
    let tokenCallback: ((response: { access_token?: string }) => void) | null =
      null
    const requestAccessToken = vi.fn(() => {
      tokenCallback?.({ access_token: 'human-iam-token' })
    })
    const initTokenClient = vi.fn((options) => {
      tokenCallback = options.callback
      return {
        callback: options.callback,
        requestAccessToken,
      }
    })
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient,
        },
      },
    }
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/userinfo')) {
        return new Response(JSON.stringify({ email: 'jeremy@lewi.us' }), {
          status: 200,
        })
      }
      if (url.endsWith(':generateAccessToken')) {
        return new Response(
          JSON.stringify({
            accessToken: 'service-account-drive-token',
            expireTime: new Date(Date.now() + 3600_000).toISOString(),
          }),
          { status: 200 }
        )
      }
      if (url.endsWith(':generateIdToken')) {
        return new Response(JSON.stringify({ token: idToken }), { status: 200 })
      }
      if (url.includes('/drive/v3/about')) {
        return new Response(
          JSON.stringify({ user: { permissionId: 'service-account-id' } }),
          { status: 200 }
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const auth = await renderWithGoogleAuthProvider()

    let status: Awaited<ReturnType<typeof auth.getServiceAccountCredentials>>
    await act(async () => {
      status = await auth.getServiceAccountCredentials(
        'runme@example.iam.gserviceaccount.com',
        {
          appAudience: 'runme-client.apps.googleusercontent.com',
          humanAccount: 'jeremy@lewi.us',
          authorizationLeaseSeconds: 86_400,
        }
      )
    })

    expect(status!).toMatchObject({
      status: 'authorized',
      humanPrincipal: 'jeremy@lewi.us',
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
      drive: { scopes: expect.arrayContaining(DRIVE_SCOPES) },
      app: { audience: 'runme-client.apps.googleusercontent.com' },
    })
    expect(initTokenClient).toHaveBeenCalledWith(
      expect.objectContaining({ login_hint: 'jeremy@lewi.us' })
    )
    expect(requestAccessToken).toHaveBeenCalledWith({
      prompt: '',
      login_hint: 'jeremy@lewi.us',
    })
    expect(status!).not.toHaveProperty('drive.accessToken')
    expect(status!).not.toHaveProperty('app.idToken')
    await expect(auth.ensureAccessToken()).resolves.toBe(
      'service-account-drive-token'
    )
    expect(getBrowserAdapter().simpleAuth?.idToken).toBe(idToken)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem('oidc-auth')).toBeNull()
  })

  it('does not install an impersonated Drive token when the Drive API is disabled', async () => {
    saveAppLoginConfiguration({
      ...DEFAULT_APP_LOGIN_CONFIGURATION,
      identitySharing: 'separate',
      driveMode: 'service_account',
      driveHumanAccount: 'jeremy@lewi.us',
      driveServiceAccount: 'runme@runme-lewi-dev.iam.gserviceaccount.com',
    })
    let tokenCallback: ((response: { access_token?: string }) => void) | null =
      null
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn((options) => {
            tokenCallback = options.callback
            return {
              callback: options.callback,
              requestAccessToken: vi.fn(() => {
                tokenCallback?.({ access_token: 'human-iam-token' })
              }),
            }
          }),
        },
      },
    }
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/userinfo')) {
        return new Response(JSON.stringify({ email: 'jeremy@lewi.us' }), {
          status: 200,
        })
      }
      if (url.endsWith(':generateAccessToken')) {
        return new Response(
          JSON.stringify({
            accessToken: 'unusable-drive-token',
            expireTime: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200 }
        )
      }
      if (url.includes('/drive/v3/about')) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'Google Drive API is disabled.',
              details: [
                {
                  reason: 'SERVICE_DISABLED',
                  metadata: { service: 'drive.googleapis.com' },
                },
              ],
            },
          }),
          { status: 403, statusText: 'Forbidden' }
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const auth = await renderWithGoogleAuthProvider()

    let authorizationError: unknown
    await act(async () => {
      try {
        await auth.getServiceAccountCredentials(
          'runme@runme-lewi-dev.iam.gserviceaccount.com',
          {
            humanAccount: 'jeremy@lewi.us',
            mode: 'popup',
            targets: ['drive'],
          }
        )
      } catch (error) {
        authorizationError = error
      }
    })
    expect(authorizationError).toBeInstanceOf(Error)
    expect((authorizationError as Error).message).toContain(
      'Google Drive API is not enabled for service-account project runme-lewi-dev'
    )
    expect(
      window.localStorage.getItem(
        IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY
      )
    ).toBeNull()
    await expect(
      auth.ensureAccessToken({ interactive: false })
    ).rejects.toThrow('Google Drive service-account authorization is required')
  })

  it('rejects a Google account that does not match the configured human', async () => {
    const tokenClient = {
      callback: vi.fn(),
      requestAccessToken: vi.fn(),
    }
    tokenClient.requestAccessToken.mockImplementation(() => {
      tokenClient.callback({ access_token: 'wrong-human-token' })
    })
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn((options) => {
            tokenClient.callback = options.callback
            return tokenClient
          }),
        },
      },
    }
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ email: 'jlewi@openai.com' }), {
        status: 200,
      })
    )
    const auth = await renderWithGoogleAuthProvider()

    await expect(
      auth.getServiceAccountCredentials(
        'runme@example.iam.gserviceaccount.com',
        { humanAccount: 'jeremy@lewi.us', mode: 'popup' }
      )
    ).rejects.toThrow(
      'Google authorized jlewi@openai.com, but jeremy@lewi.us is required'
    )
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(
      window.localStorage.getItem(
        IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY
      )
    ).toBeNull()
  })

  it('starts implicit service-account auth in a new tab without persisting a human token', async () => {
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(window as unknown as Window)
    const auth = await renderWithGoogleAuthProvider()

    await expect(
      auth.getServiceAccountCredentials(
        'runme@example.iam.gserviceaccount.com',
        {
          humanAccount: 'jeremy@lewi.us',
          targets: ['drive'],
          mode: 'new_tab',
        }
      )
    ).resolves.toMatchObject({
      status: 'started',
      humanPrincipal: 'jeremy@lewi.us',
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
    })

    const transaction = window.localStorage.getItem(
      IMPERSONATION_TRANSACTION_KEY
    )
    expect(transaction).toBeTruthy()
    expect(transaction).not.toContain('access_token')
    expect(transaction).not.toContain('refresh_token')
    const authUrl = new URL(String(openSpy.mock.calls[0]?.[0]))
    expect(authUrl.searchParams.get('response_type')).toBe('token')
    expect(authUrl.searchParams.get('access_type')).toBe('online')
    expect(authUrl.searchParams.get('code_challenge')).toBeNull()
    expect(authUrl.searchParams.get('login_hint')).toBe('jeremy@lewi.us')
    expect(authUrl.searchParams.get('scope')).toContain('cloud-platform')
  })

  it('uses PKCE for service-account auth when the code flow is configured', async () => {
    googleClientManager.setOAuthClient({
      authFlow: 'pkce',
      authUxMode: 'new_tab',
    })
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(window as unknown as Window)
    const auth = await renderWithGoogleAuthProvider()

    await auth.getServiceAccountCredentials(
      'runme@example.iam.gserviceaccount.com',
      {
        humanAccount: 'jeremy@lewi.us',
        targets: ['drive'],
        mode: 'new_tab',
      }
    )

    const authUrl = new URL(String(openSpy.mock.calls[0]?.[0]))
    expect(authUrl.searchParams.get('response_type')).toBe('code')
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy()
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('consumes an implicit human token from the callback without persisting it', async () => {
    saveAppLoginConfiguration({
      ...DEFAULT_APP_LOGIN_CONFIGURATION,
      mode: 'service_account',
      humanAccount: 'jeremy@lewi.us',
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
    })
    window.localStorage.setItem(
      IMPERSONATION_TRANSACTION_KEY,
      JSON.stringify({
        version: 2,
        state: 'impersonation-state',
        responseType: 'token',
        createdAt: Date.now(),
        returnTo: '/',
        mode: 'redirect',
        serviceAccount: 'runme@example.iam.gserviceaccount.com',
        humanAccount: 'jeremy@lewi.us',
        targets: ['drive'],
        driveScopes: DRIVE_SCOPES,
        appAudience: '',
        authorizationLeaseSeconds: 86_400,
      })
    )
    window.history.replaceState(
      null,
      '',
      '/gdrive/callback#access_token=human-callback-token&expires_in=3600&state=impersonation-state'
    )
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/userinfo')) {
        return new Response(JSON.stringify({ email: 'jeremy@lewi.us' }), {
          status: 200,
        })
      }
      if (url.endsWith(':generateAccessToken')) {
        return new Response(
          JSON.stringify({
            accessToken: 'service-account-drive-token',
            expireTime: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200 }
        )
      }
      if (url.includes('/drive/v3/about')) {
        return new Response(
          JSON.stringify({ user: { permissionId: 'service-account-id' } }),
          { status: 200 }
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    await renderWithGoogleAuthProvider()

    await waitFor(() => {
      const persisted = window.localStorage.getItem(
        IMPERSONATED_SERVICE_ACCOUNT_CREDENTIAL_STORAGE_KEY
      )
      expect(persisted).toContain('service-account-drive-token')
      expect(persisted).not.toContain('human-callback-token')
      expect(window.location.hash).toBe('')
    })
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.anything()
    )
  })

  it('hydrates a persisted Drive service-account credential after reload', async () => {
    saveAppLoginConfiguration({
      ...DEFAULT_APP_LOGIN_CONFIGURATION,
      mode: 'service_account',
      humanAccount: 'jeremy@lewi.us',
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
    })
    mergeImpersonatedServiceAccountCredential({
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
      humanPrincipal: 'jeremy@lewi.us',
      authorizationLeaseExpiresAt: new Date(
        Date.now() + 86_400_000
      ).toISOString(),
      drive: {
        accessToken: 'persisted-service-account-drive-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: DRIVE_SCOPES,
      },
    })
    const auth = await renderWithGoogleAuthProvider()

    await expect(auth.ensureAccessToken()).resolves.toBe(
      'persisted-service-account-drive-token'
    )
    expect(auth.driveCredentialStatus).toMatchObject({
      authFlow: 'impersonated_service_account',
      effectivePrincipal: 'runme@example.iam.gserviceaccount.com',
      authorizingPrincipal: 'jeremy@lewi.us',
    })
  })

  it('retains the last impersonation error for status diagnostics', async () => {
    window.localStorage.setItem(
      IMPERSONATION_RESULT_KEY,
      JSON.stringify({
        state: 'failed-impersonation',
        status: 'error',
        serviceAccount: 'runme@example.iam.gserviceaccount.com',
        message: 'IAM Credentials API is disabled.',
        completedAt: Date.now(),
      })
    )

    const auth = await renderWithGoogleAuthProvider()

    await waitFor(() => {
      expect(auth.driveCredentialStatus.lastError).toBe(
        'IAM Credentials API is disabled.'
      )
    })
    expect(window.localStorage.getItem(IMPERSONATION_RESULT_KEY)).toContain(
      'IAM Credentials API is disabled.'
    )
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

  it('uses the remembered Drive account for silent new-tab authorization', async () => {
    googleClientManager.setOAuthClient({
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
    window.localStorage.setItem(STORED_DRIVE_ACCOUNT_KEY, 'jlewi@openai.com')
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(window as unknown as Window)
    const auth = await renderWithGoogleAuthProvider()

    await expect(auth.startGoogleDriveOAuth()).resolves.toMatchObject({
      status: 'started',
      authFlow: 'implicit',
      mode: 'new_tab',
    })

    const authUrl = new URL(String(openSpy.mock.calls[0]?.[0]))
    expect(authUrl.searchParams.get('prompt')).toBe('none')
    expect(authUrl.searchParams.get('login_hint')).toBe('jlewi@openai.com')
  })

  it('preserves the remembered Drive account when consent is required', async () => {
    googleClientManager.setOAuthClient({
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
    window.localStorage.setItem(STORED_DRIVE_ACCOUNT_KEY, 'jlewi@openai.com')
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(window as unknown as Window)
    const auth = await renderWithGoogleAuthProvider()

    await auth.startGoogleDriveOAuth({ prompt: 'consent' })

    const authUrl = new URL(String(openSpy.mock.calls[0]?.[0]))
    expect(authUrl.searchParams.get('prompt')).toBe('consent')
    expect(authUrl.searchParams.get('login_hint')).toBe('jlewi@openai.com')
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

  it('replaces an implicit account hint after PKCE authorizes another account', async () => {
    googleClientManager.setOAuthClient({
      authFlow: 'pkce',
      authUxMode: 'new_tab',
    })
    window.localStorage.setItem(
      STORED_DRIVE_ACCOUNT_KEY,
      'implicit-account@example.com'
    )
    window.localStorage.setItem(PKCE_STATE_KEY, 'pkce-state')
    window.localStorage.setItem(PKCE_CODE_VERIFIER_KEY, 'pkce-verifier')
    window.localStorage.setItem(PKCE_RETURN_TO_KEY, '/')
    window.history.replaceState(
      null,
      '',
      '/gdrive/callback?code=pkce-code&state=pkce-state'
    )
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({
            access_token: 'pkce-access-token',
            expires_in: 3600,
            refresh_token: 'pkce-refresh-token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (String(input) === DRIVE_ABOUT_URL) {
        return new Response(
          JSON.stringify({
            user: { emailAddress: 'pkce-account@example.com' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      throw new Error(`Unexpected fetch: ${String(input)}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(window as unknown as Window)
    const auth = await renderWithGoogleAuthProvider()

    await waitFor(() => {
      expect(window.localStorage.getItem(STORED_DRIVE_ACCOUNT_KEY)).toBe(
        'pkce-account@example.com'
      )
      expect(window.localStorage.getItem(PKCE_STATE_KEY)).toBeNull()
    })

    window.history.replaceState(null, '', '/')
    googleClientManager.setOAuthClient({
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
    await act(async () => {
      await auth.startGoogleDriveOAuth()
    })

    const authUrl = new URL(String(openSpy.mock.calls[0]?.[0]))
    expect(authUrl.searchParams.get('login_hint')).toBe(
      'pkce-account@example.com'
    )
    expect(fetchMock).toHaveBeenCalledWith(
      DRIVE_ABOUT_URL,
      expect.objectContaining({
        headers: { Authorization: 'Bearer pkce-access-token' },
      })
    )
  })

  it('clears and revokes Drive credentials, then asks Google to select an account', async () => {
    const tokenClient = {
      callback: vi.fn(),
      requestAccessToken: vi.fn(),
    }
    tokenClient.requestAccessToken.mockImplementation(() => {
      tokenClient.callback({
        access_token: 'replacement-access-token',
        expires_in: 3600,
      })
    })
    const revoke = vi.fn((_accessToken: string, callback: () => void) => {
      callback()
    })
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn(() => tokenClient),
          revoke,
        },
      },
    }
    const auth = await renderWithGoogleAuthProvider()

    await act(async () => {
      auth.setAccessToken('original-access-token')
    })
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain(
      'original-access-token'
    )

    await act(async () => {
      await auth.logoutGoogleDrive()
    })

    expect(revoke).toHaveBeenCalledWith(
      'original-access-token',
      expect.any(Function)
    )
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(SELECT_ACCOUNT_NEXT_KEY)).toBe('true')

    await act(async () => {
      await auth.startGoogleDriveOAuth()
    })

    expect(tokenClient.requestAccessToken).toHaveBeenCalledWith({
      prompt: 'select_account',
    })
    expect(window.localStorage.getItem(SELECT_ACCOUNT_NEXT_KEY)).toBeNull()
    expect(window.localStorage.getItem(STORED_DRIVE_ACCOUNT_KEY)).toBe(
      'jlewi@openai.com'
    )
  })

  it('initializes popup OAuth with the remembered Drive account', async () => {
    window.localStorage.setItem(STORED_DRIVE_ACCOUNT_KEY, 'jlewi@openai.com')
    const tokenClient = {
      callback: vi.fn(),
      requestAccessToken: vi.fn(),
    }
    tokenClient.requestAccessToken.mockImplementation(() => {
      tokenClient.callback({
        access_token: 'replacement-access-token',
        expires_in: 3600,
      })
    })
    const initTokenClient = vi.fn(() => tokenClient)
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient,
        },
      },
    }
    const auth = await renderWithGoogleAuthProvider()

    await act(async () => {
      await auth.startGoogleDriveOAuth()
    })

    expect(initTokenClient).toHaveBeenCalledWith(
      expect.objectContaining({
        login_hint: 'jlewi@openai.com',
      })
    )
    expect(tokenClient.requestAccessToken).toHaveBeenCalledWith({
      prompt: 'none',
    })
  })

  it('retries silent popup authorization with consent when login is required', async () => {
    window.localStorage.setItem(STORED_DRIVE_ACCOUNT_KEY, 'jlewi@openai.com')
    const hintedTokenClient = {
      callback: vi.fn(),
      requestAccessToken: vi.fn(),
    }
    const consentTokenClient = {
      callback: vi.fn(),
      requestAccessToken: vi.fn(),
    }
    hintedTokenClient.requestAccessToken.mockImplementation(() => {
      hintedTokenClient.callback({ error: 'login_required' })
    })
    consentTokenClient.requestAccessToken.mockImplementation(() => {
      consentTokenClient.callback({
        access_token: 'replacement-access-token',
        expires_in: 3600,
      })
    })
    const initTokenClient = vi
      .fn()
      .mockReturnValueOnce(hintedTokenClient)
      .mockReturnValueOnce(consentTokenClient)
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient,
        },
      },
    }
    const auth = await renderWithGoogleAuthProvider()

    let accessToken = ''
    await act(async () => {
      accessToken = await auth.ensureAccessToken({ interactive: true })
    })

    expect(accessToken).toBe('replacement-access-token')
    expect(hintedTokenClient.requestAccessToken).toHaveBeenCalledWith({
      prompt: 'none',
    })
    expect(consentTokenClient.requestAccessToken).toHaveBeenCalledWith({
      prompt: 'consent',
    })
    expect(initTokenClient.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ login_hint: 'jlewi@openai.com' })
    )
    expect(initTokenClient.mock.calls[1]?.[0]).not.toHaveProperty('login_hint')
    expect(window.localStorage.getItem(STORED_DRIVE_ACCOUNT_KEY)).toBe(
      'jlewi@openai.com'
    )
  })

  it('recreates the popup client without a stale hint before explicit consent', async () => {
    window.localStorage.setItem(STORED_DRIVE_ACCOUNT_KEY, 'jlewi@openai.com')
    const hintedTokenClient = {
      callback: vi.fn(),
      requestAccessToken: vi.fn(),
    }
    const consentTokenClient = {
      callback: vi.fn(),
      requestAccessToken: vi.fn(),
    }
    hintedTokenClient.requestAccessToken.mockImplementation(() => {
      hintedTokenClient.callback({ error: 'interaction_required' })
    })
    consentTokenClient.requestAccessToken.mockImplementation(() => {
      consentTokenClient.callback({
        access_token: 'replacement-access-token',
        expires_in: 3600,
      })
    })
    const initTokenClient = vi
      .fn()
      .mockReturnValueOnce(hintedTokenClient)
      .mockReturnValueOnce(consentTokenClient)
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient,
        },
      },
    }
    const auth = await renderWithGoogleAuthProvider()

    let result: Awaited<ReturnType<typeof auth.startGoogleDriveOAuth>> | null =
      null
    await act(async () => {
      result = await auth.startGoogleDriveOAuth()
    })

    expect(result).toMatchObject({
      status: 'authorized',
      accessToken: 'replacement-access-token',
    })

    expect(hintedTokenClient.requestAccessToken).toHaveBeenCalledWith({
      prompt: 'none',
    })
    expect(consentTokenClient.requestAccessToken).toHaveBeenCalledWith({
      prompt: 'consent',
    })
    expect(initTokenClient.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ login_hint: 'jlewi@openai.com' })
    )
    expect(initTokenClient.mock.calls[1]?.[0]).not.toHaveProperty('login_hint')
  })

  it('adopts a remembered Drive account changed by another tab', async () => {
    window.localStorage.setItem(
      STORED_DRIVE_ACCOUNT_KEY,
      'old-account@example.com'
    )
    const tokenClient = {
      callback: vi.fn(),
      requestAccessToken: vi.fn(),
    }
    tokenClient.requestAccessToken.mockImplementation(() => {
      tokenClient.callback({
        access_token: 'replacement-access-token',
        expires_in: 3600,
      })
    })
    const initTokenClient = vi.fn(() => tokenClient)
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient,
        },
      },
    }
    const auth = await renderWithGoogleAuthProvider()

    await act(async () => {
      window.localStorage.setItem(
        STORED_DRIVE_ACCOUNT_KEY,
        'new-account@example.com'
      )
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORED_DRIVE_ACCOUNT_KEY,
          newValue: 'new-account@example.com',
          storageArea: window.localStorage,
        })
      )
      await auth.startGoogleDriveOAuth()
    })

    expect(initTokenClient).toHaveBeenCalledWith(
      expect.objectContaining({
        login_hint: 'new-account@example.com',
      })
    )
  })

  it('finishes implicit authorization when another tab stores its account hint', async () => {
    let resolveAccountLookup!: (response: Response) => void
    const accountLookup = new Promise<Response>((resolve) => {
      resolveAccountLookup = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => accountLookup)
    )
    const tokenClient = {
      callback: vi.fn(),
      requestAccessToken: vi.fn(),
    }
    tokenClient.requestAccessToken.mockImplementation(() => {
      tokenClient.callback({
        access_token: 'replacement-access-token',
        expires_in: 3600,
      })
    })
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn(() => tokenClient),
        },
      },
    }
    const auth = await renderWithGoogleAuthProvider()
    const resultPromise = auth.startGoogleDriveOAuth()

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        DRIVE_ABOUT_URL,
        expect.objectContaining({
          headers: { Authorization: 'Bearer replacement-access-token' },
        })
      )
    })

    await act(async () => {
      window.localStorage.setItem(STORED_DRIVE_ACCOUNT_KEY, 'jlewi@openai.com')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORED_DRIVE_ACCOUNT_KEY,
          newValue: 'jlewi@openai.com',
          storageArea: window.localStorage,
        })
      )
      resolveAccountLookup(
        new Response(
          JSON.stringify({ user: { emailAddress: 'jlewi@openai.com' } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
      await resultPromise
    })

    await expect(resultPromise).resolves.toMatchObject({
      status: 'authorized',
      accessToken: 'replacement-access-token',
    })
  })

  it('uses the Google account chooser for new-tab auth after logout', async () => {
    googleClientManager.setOAuthClient({
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
    window.localStorage.setItem(STORED_DRIVE_ACCOUNT_KEY, 'jlewi@openai.com')
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(window as unknown as Window)
    const auth = await renderWithGoogleAuthProvider()

    await act(async () => {
      await auth.logoutGoogleDrive()
      await auth.startGoogleDriveOAuth()
    })

    expect(openSpy).toHaveBeenCalledTimes(1)
    const authUrl = new URL(String(openSpy.mock.calls[0]?.[0]))
    expect(authUrl.searchParams.get('prompt')).toBe('select_account')
    expect(authUrl.searchParams.get('login_hint')).toBeNull()
    expect(window.localStorage.getItem(STORED_DRIVE_ACCOUNT_KEY)).toBeNull()
    expect(window.localStorage.getItem(SELECT_ACCOUNT_NEXT_KEY)).toBeNull()
  })

  it('does not restore credentials when a refresh finishes after logout', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: 'expired-access-token',
        expiresAt: Date.now() - 1,
        authFlow: 'implicit',
        refreshToken: 'refresh-token',
      })
    )
    const revoke = vi.fn((_accessToken: string, callback: () => void) => {
      callback()
    })
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn(),
          revoke,
        },
      },
    }
    let resolveRefresh!: (response: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const auth = await renderWithGoogleAuthProvider()

    const pendingToken = auth.ensureAccessToken({ interactive: false })
    const rejection = expect(pendingToken).rejects.toThrow(
      'Google Drive session ended.'
    )
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      await auth.logoutGoogleDrive()
      resolveRefresh(
        new Response(
          JSON.stringify({
            access_token: 'late-access-token',
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    })

    await rejection
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(revoke).toHaveBeenCalledWith(
      'expired-access-token',
      expect.any(Function)
    )
  })

  it('does not restore credentials when service account minting finishes after logout', async () => {
    googleClientManager.setOAuthClient({
      clientId: '',
      authFlow: 'service_account',
      authUxMode: 'new_tab',
      serviceAccount: {
        clientEmail: 'runme-drive-test@example.iam.gserviceaccount.com',
        privateKey: await generatePrivateKeyPem(),
      },
    })
    let resolveMint!: (response: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveMint = resolve
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const auth = await renderWithGoogleAuthProvider()

    const pendingToken = auth.ensureAccessToken({ interactive: false })
    const rejection = expect(pendingToken).rejects.toThrow(
      'Google Drive session ended.'
    )
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      await auth.logoutGoogleDrive()
      resolveMint(
        new Response(
          JSON.stringify({
            access_token: 'late-service-account-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      )
    })

    await rejection
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
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

  it('migrates an existing implicit session to a remembered Drive account', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: 'existing-access-token',
        expiresAt: Date.now() + 30 * 60 * 1000,
        authFlow: 'implicit',
      })
    )
    const auth = await renderWithGoogleAuthProvider()

    await waitFor(() => {
      expect(window.localStorage.getItem(STORED_DRIVE_ACCOUNT_KEY)).toBe(
        'jlewi@openai.com'
      )
    })

    expect(fetch).toHaveBeenCalledWith(
      DRIVE_ABOUT_URL,
      expect.objectContaining({
        headers: { Authorization: 'Bearer existing-access-token' },
        signal: expect.any(AbortSignal),
      })
    )
    await expect(auth.ensureAccessToken({ interactive: false })).resolves.toBe(
      'existing-access-token'
    )
  })

  it('does not let an old token migration overwrite a newer account', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: 'old-access-token',
        expiresAt: Date.now() + 30 * 60 * 1000,
        authFlow: 'implicit',
      })
    )
    let resolveOldLookup!: (response: Response) => void
    let resolveNewLookup!: (response: Response) => void
    const oldLookup = new Promise<Response>((resolve) => {
      resolveOldLookup = resolve
    })
    const newLookup = new Promise<Response>((resolve) => {
      resolveNewLookup = resolve
    })
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('Authorization')
        return authorization === 'Bearer old-access-token'
          ? oldLookup
          : newLookup
      }
    )
    vi.stubGlobal('fetch', fetchMock)
    const auth = await renderWithGoogleAuthProvider()

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        DRIVE_ABOUT_URL,
        expect.objectContaining({
          headers: { Authorization: 'Bearer old-access-token' },
        })
      )
    })

    await act(async () => {
      auth.setAccessToken('new-access-token')
    })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        DRIVE_ABOUT_URL,
        expect.objectContaining({
          headers: { Authorization: 'Bearer new-access-token' },
        })
      )
    })

    await act(async () => {
      resolveNewLookup(
        new Response(
          JSON.stringify({ user: { emailAddress: 'new@example.com' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    })
    await waitFor(() => {
      expect(window.localStorage.getItem(STORED_DRIVE_ACCOUNT_KEY)).toBe(
        'new@example.com'
      )
    })

    await act(async () => {
      resolveOldLookup(
        new Response(
          JSON.stringify({ user: { emailAddress: 'old@example.com' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      await Promise.resolve()
    })
    expect(window.localStorage.getItem(STORED_DRIVE_ACCOUNT_KEY)).toBe(
      'new@example.com'
    )
  })

  it('does not migrate a stored service-account token as a browser account', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: 'service-account-token',
        expiresAt: Date.now() + 30 * 60 * 1000,
        authFlow: 'service_account',
      })
    )

    await renderWithGoogleAuthProvider()
    await act(async () => {
      await Promise.resolve()
    })

    expect(fetch).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(STORED_DRIVE_ACCOUNT_KEY)).toBeNull()
  })

  it('keeps implicit authorization usable when account discovery fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 }))
    )
    const tokenClient = {
      callback: vi.fn(),
      requestAccessToken: vi.fn(),
    }
    tokenClient.requestAccessToken.mockImplementation(() => {
      tokenClient.callback({
        access_token: 'replacement-access-token',
        expires_in: 3600,
      })
    })
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn(() => tokenClient),
        },
      },
    }
    const auth = await renderWithGoogleAuthProvider()

    let result: Awaited<ReturnType<typeof auth.startGoogleDriveOAuth>> | null =
      null
    await act(async () => {
      result = await auth.startGoogleDriveOAuth()
    })

    expect(result).toMatchObject({
      status: 'authorized',
      accessToken: 'replacement-access-token',
    })
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain(
      'replacement-access-token'
    )
    expect(window.localStorage.getItem(STORED_DRIVE_ACCOUNT_KEY)).toBeNull()
  })

  it('accepts the implicit token before a stalled account lookup times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    )
    const tokenClient = {
      callback: vi.fn(),
      requestAccessToken: vi.fn(),
    }
    tokenClient.requestAccessToken.mockImplementation(() => {
      tokenClient.callback({
        access_token: 'replacement-access-token',
        expires_in: 3600,
      })
    })
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn(() => tokenClient),
        },
      },
    }
    const auth = await renderWithGoogleAuthProvider()
    vi.useFakeTimers()

    try {
      let resultPromise:
        | ReturnType<typeof auth.startGoogleDriveOAuth>
        | undefined
      await act(async () => {
        resultPromise = auth.startGoogleDriveOAuth()
        await Promise.resolve()
      })

      expect(window.localStorage.getItem(STORAGE_KEY)).toContain(
        'replacement-access-token'
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      await expect(resultPromise!).resolves.toMatchObject({
        status: 'authorized',
        accessToken: 'replacement-access-token',
      })
    } finally {
      vi.useRealTimers()
    }
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
