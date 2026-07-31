import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import pkceChallenge from 'pkce-challenge'
import { mintGoogleServiceAccountAccessToken } from '../auth/googleServiceAccount'
import { googleClientManager } from '../lib/googleClientManager'
import {
  APP_ROUTE_PATHS,
  getAppPath,
  getGoogleDriveOAuthCallbackUrl,
} from '../lib/appBase'
import type {
  GoogleDriveAuthFlow,
  GoogleDriveAuthUxMode,
} from '../lib/googleClientManager'
import { appLogger } from '../lib/logging/runtime'
import { markOnboardingTaskComplete } from '../lib/onboarding'
import { appState } from '../lib/runtime/AppState'

// N.B. I couldn't make sharing work with the more restrictive "https://www.googleapis.com/auth/drive.file"
// scope. In particular, I couldn't quite figure out how to share a link with a user and then have that
// user go through the Drive Picker flow to associate that file with the app. So for now we use the broader
// drive scope to give the app access to all of the user's files.
export const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.install',
]

const STORAGE_KEY = 'runme/google-auth/token'
const LEGACY_STORAGE_KEY = 'aisre/google-auth/token'
const PKCE_STATE_KEY = 'runme/google-auth/pkce-state'
const PKCE_CODE_VERIFIER_KEY = 'runme/google-auth/pkce-code-verifier'
const PKCE_RETURN_TO_KEY = 'runme/google-auth/pkce-return-to'
const PKCE_ERROR_KEY = 'runme/google-auth/pkce-error'
const IMPLICIT_PROMPT_MODE_KEY = 'runme/google-auth/implicit-prompt-mode'
const AUTH_HANDOFF_MODE_KEY = 'runme/google-auth/handoff-mode'
const SELECT_ACCOUNT_NEXT_KEY = 'runme/google-auth/select-account-next'
const AUTH_SESSION_EPOCH_KEY = 'runme/google-auth/session-epoch'

interface AccessTokenInfo {
  token: string
  expiresAt: number
  authFlow?: GoogleDriveAuthFlow
  refreshToken?: string
}

interface EnsureAccessTokenOptions {
  interactive?: boolean
}

export interface StartGoogleDriveOAuthOptions {
  mode?: GoogleDriveAuthUxMode
  prompt?: GoogleOAuthPrompt
}

export interface StartGoogleDriveOAuthResult {
  status: 'started' | 'authorized'
  authFlow: GoogleDriveAuthFlow
  mode: GoogleDriveAuthUxMode
  accessToken?: string
}

interface GoogleAuthContextType {
  ensureAccessToken: (options?: EnsureAccessTokenOptions) => Promise<string>
  logoutGoogleDrive: () => Promise<void>
  startGoogleDriveOAuth: (
    options?: StartGoogleDriveOAuthOptions
  ) => Promise<StartGoogleDriveOAuthResult>
  setAccessToken: (token: string, expiresIn?: number) => void
  isDriveSyncing: boolean
}

type GoogleRedirectUxMode = Extract<
  GoogleDriveAuthUxMode,
  'redirect' | 'new_tab'
>

type GoogleOAuthPrompt = 'none' | 'consent' | 'select_account'

type AuthOperationVersion = {
  generation: number
  sessionEpoch: string | null
}

class StaleGoogleAuthOperationError extends Error {
  constructor() {
    super('Google Drive session ended.')
    this.name = 'StaleGoogleAuthOperationError'
  }
}

type PendingHandlers = {
  resolve: (token: string) => void
  reject: (error: unknown) => void
}

interface TokenClient {
  callback: (response: AccessTokenResponse) => void
  requestAccessToken: (options?: { prompt?: GoogleOAuthPrompt | '' }) => void
}

interface AccessTokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  token_type?: string
  error?: string
  error_description?: string
}

interface GoogleOAuth {
  initTokenClient: (options: {
    client_id: string
    scope: string
    callback: (response: AccessTokenResponse) => void
  }) => TokenClient
  revoke?: (accessToken: string, callback: () => void) => void
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: GoogleOAuth
      }
    }
  }
}

const GoogleAuthContext = createContext<GoogleAuthContextType | undefined>(
  undefined
)

// eslint-disable-next-line react-refresh/only-export-components
export function useGoogleAuth() {
  const ctx = useContext(GoogleAuthContext)
  if (!ctx) {
    throw new Error('useGoogleAuth must be used within a GoogleAuthProvider')
  }
  return ctx
}

const REFRESH_MARGIN_MS = 60_000

// GoogleAuthProvider owns all OAuth state for the app. It exposes a small
// surface (ensureAccessToken / setAccessToken) through context so the rest of
// the codebase never has to think about how tokens are minted, refreshed, or
// cached.
function loadStoredToken(): AccessTokenInfo | null {
  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<AccessTokenInfo> | null
    if (!parsed?.token || typeof parsed.token !== 'string') {
      window.localStorage.removeItem(STORAGE_KEY)
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
      return null
    }
    if (typeof parsed.expiresAt !== 'number') {
      window.localStorage.removeItem(STORAGE_KEY)
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
      return null
    }
    const refreshToken =
      typeof parsed.refreshToken === 'string' && parsed.refreshToken.trim()
        ? parsed.refreshToken.trim()
        : undefined

    if (parsed.expiresAt <= Date.now() + REFRESH_MARGIN_MS && !refreshToken) {
      window.localStorage.removeItem(STORAGE_KEY)
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
      return null
    }
    return {
      token: parsed.token,
      expiresAt: parsed.expiresAt,
      authFlow:
        parsed.authFlow === 'implicit' ||
        parsed.authFlow === 'pkce' ||
        parsed.authFlow === 'service_account'
          ? parsed.authFlow
          : undefined,
      refreshToken,
    }
  } catch (error) {
    console.error('Failed to read Google auth token from storage', error)
    return null
  }
}

export function GoogleAuthProvider({ children }: { children: ReactNode }) {
  // tokenInfo lives in React state so rerenders propagate an updated token to
  // any components that care about it. We store both the raw token and the
  // computed expiration time so we can avoid making unnecessary OAuth round
  // trips. When the token changes, React will re-render this provider and
  // consequently re-run any hooks that depend on tokenInfo.
  const [tokenInfo, setTokenInfo] = useState<AccessTokenInfo | null>(
    loadStoredToken
  )
  const [nowMs, setNowMs] = useState(() => Date.now())

  // The remaining mutable pieces do not participate in rendering, so they are
  // stored in refs instead of state. This keeps React from re-rendering whenever
  // these values change and also gives us stable references across function
  // calls.
  const tokenInfoRef = useRef<AccessTokenInfo | null>(null)
  const tokenClientRef = useRef<TokenClient | null>(null)
  const oauthClientIdRef = useRef<string | null>(null)
  const handlersRef = useRef<PendingHandlers | null>(null)
  const pendingPromiseRef = useRef<Promise<string> | null>(null)
  const scriptPromiseRef = useRef<Promise<void> | null>(null)
  const callbackPromiseRef = useRef<Promise<void> | null>(null)
  const callbackErrorRef = useRef<unknown>(null)
  // Every asynchronous authorization operation captures both this per-tab
  // generation and the shared session epoch. Logout changes both values so a
  // response already in flight cannot restore credentials after sign-out,
  // including when the OAuth callback is running in another tab.
  const authGenerationRef = useRef(0)

  const readAuthSessionEpoch = useCallback(() => {
    try {
      return window.localStorage.getItem(AUTH_SESSION_EPOCH_KEY)
    } catch {
      return null
    }
  }, [])

  const captureAuthOperation = useCallback(
    (): AuthOperationVersion => ({
      generation: authGenerationRef.current,
      sessionEpoch: readAuthSessionEpoch(),
    }),
    [readAuthSessionEpoch]
  )

  const assertAuthOperationCurrent = useCallback(
    (operation: AuthOperationVersion) => {
      if (
        operation.generation !== authGenerationRef.current ||
        operation.sessionEpoch !== readAuthSessionEpoch()
      ) {
        throw new StaleGoogleAuthOperationError()
      }
    },
    [readAuthSessionEpoch]
  )

  const invalidatePendingAuth = useCallback((message: string) => {
    const hadPendingAuth = Boolean(
      handlersRef.current ||
        pendingPromiseRef.current ||
        callbackPromiseRef.current
    )
    authGenerationRef.current += 1
    handlersRef.current?.reject(new StaleGoogleAuthOperationError())
    handlersRef.current = null
    pendingPromiseRef.current = null
    callbackPromiseRef.current = null
    tokenClientRef.current = null
    oauthClientIdRef.current = null
    if (hadPendingAuth) {
      appLogger.info(message, {
        attrs: {
          scope: 'storage.drive.auth',
          code: 'DRIVE_AUTH_PENDING_INVALIDATED',
        },
      })
    }
  }, [])

  const advanceAuthSessionEpoch = useCallback(() => {
    const epoch = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`
    try {
      window.localStorage.setItem(AUTH_SESSION_EPOCH_KEY, epoch)
    } catch (error) {
      appLogger.error('Failed to update Google Drive auth session epoch', {
        attrs: {
          scope: 'storage.drive.auth',
          code: 'DRIVE_AUTH_SESSION_EPOCH_UPDATE_FAILED',
          error: String(error),
        },
      })
    }
  }, [])

  // useCallback memoises the function instance so consumers receive a stable
  // reference between renders. That is important because the callback is passed
  // to other hooks and stored in refs; without useCallback React would recreate
  // the function every render, potentially breaking equality checks or causing
  // needless effect cleanups.
  const setAccessToken = useCallback(
    (
      token: string,
      expiresIn = 3600,
      options?: { refreshToken?: string | null }
    ) => {
      if (!token) {
        setTokenInfo(null)
        tokenInfoRef.current = null
        try {
          window.localStorage.removeItem(STORAGE_KEY)
          window.localStorage.removeItem(LEGACY_STORAGE_KEY)
        } catch (error) {
          console.error('Failed to clear Google auth token', error)
        }
        return
      }

      const refreshToken =
        options?.refreshToken === undefined
          ? tokenInfoRef.current?.refreshToken
          : options.refreshToken || undefined
      const expiresAt = Date.now() + (expiresIn * 1000 - REFRESH_MARGIN_MS)
      const info: AccessTokenInfo = {
        token,
        expiresAt,
        authFlow: googleClientManager.getOAuthClient().authFlow,
        ...(refreshToken ? { refreshToken } : {}),
      }
      setTokenInfo(info)
      tokenInfoRef.current = info
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(info))
        window.localStorage.removeItem(LEGACY_STORAGE_KEY)
      } catch (error) {
        console.error('Failed to persist Google auth token', error)
      }
      markOnboardingTaskComplete('sign-in-google-drive')
    },
    []
  )

  const clearPkceState = useCallback(
    (options?: { preserveHandoffMode?: boolean }) => {
      try {
        window.localStorage.removeItem(PKCE_STATE_KEY)
        window.localStorage.removeItem(PKCE_CODE_VERIFIER_KEY)
        window.localStorage.removeItem(PKCE_RETURN_TO_KEY)
        window.localStorage.removeItem(IMPLICIT_PROMPT_MODE_KEY)
        if (!options?.preserveHandoffMode) {
          window.localStorage.removeItem(AUTH_HANDOFF_MODE_KEY)
        }
        window.sessionStorage.removeItem(PKCE_ERROR_KEY)
      } catch (error) {
        console.error('Failed to clear Google PKCE state', error)
      }
    },
    []
  )

  const requestAccountSelectionNext = useCallback(() => {
    try {
      window.localStorage.setItem(SELECT_ACCOUNT_NEXT_KEY, 'true')
    } catch (error) {
      appLogger.error('Failed to remember Google account selection request', {
        attrs: {
          scope: 'storage.drive.auth',
          code: 'DRIVE_AUTH_ACCOUNT_SELECTION_STATE_FAILED',
          error: String(error),
        },
      })
    }
  }, [])

  const consumeAccountSelectionRequest = useCallback(() => {
    try {
      const shouldSelectAccount =
        window.localStorage.getItem(SELECT_ACCOUNT_NEXT_KEY) === 'true'
      if (shouldSelectAccount) {
        window.localStorage.removeItem(SELECT_ACCOUNT_NEXT_KEY)
      }
      return shouldSelectAccount
    } catch (error) {
      appLogger.error('Failed to read Google account selection request', {
        attrs: {
          scope: 'storage.drive.auth',
          code: 'DRIVE_AUTH_ACCOUNT_SELECTION_STATE_READ_FAILED',
          error: String(error),
        },
      })
      return false
    }
  }, [])

  const openAuthUrl = useCallback(
    (authUrl: URL, mode: GoogleRedirectUxMode) => {
      window.localStorage.setItem(AUTH_HANDOFF_MODE_KEY, mode)
      if (mode === 'new_tab') {
        const authWindow = window.open(authUrl.toString(), '_blank')
        if (authWindow) {
          authWindow.focus?.()
          return
        }
        appLogger.warn(
          'Failed to open Google OAuth in a new tab; falling back to redirect',
          {
            attrs: {
              scope: 'storage.drive.auth',
              code: 'DRIVE_AUTH_NEW_TAB_OPEN_FAILED',
            },
          }
        )
        window.localStorage.setItem(AUTH_HANDOFF_MODE_KEY, 'redirect')
      }
      window.location.assign(authUrl.toString())
    },
    []
  )

  const hasRedirectAuthHandoffInProgress = useCallback(() => {
    try {
      const state = window.localStorage.getItem(PKCE_STATE_KEY)
      const handoffMode = window.localStorage.getItem(AUTH_HANDOFF_MODE_KEY)
      return Boolean(
        state && (handoffMode === 'redirect' || handoffMode === 'new_tab')
      )
    } catch {
      return false
    }
  }, [])

  const readImplicitRedirectTokenFromHash = useCallback(() => {
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash
    if (!hash) {
      return null
    }
    const params = new URLSearchParams(hash)
    return {
      accessToken: params.get('access_token'),
      expiresInRaw: params.get('expires_in'),
      state: params.get('state'),
      error: params.get('error'),
      errorDescription: params.get('error_description'),
    }
  }, [])

  const exchangeAuthorizationCode = useCallback(
    async (
      code: string,
      codeVerifier: string
    ): Promise<AccessTokenResponse> => {
      const { clientId, clientSecret } = googleClientManager.getOAuthClient()
      if (!clientId?.trim()) {
        throw new Error('Google OAuth client is not configured.')
      }

      const body = new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: getGoogleDriveOAuthCallbackUrl(),
        grant_type: 'authorization_code',
      })
      if (clientSecret?.trim()) {
        body.set('client_secret', clientSecret.trim())
      }

      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      })

      let token: AccessTokenResponse | null = null
      try {
        token = (await response.json()) as AccessTokenResponse
      } catch {
        token = null
      }

      if (!response.ok) {
        throw new Error(
          token?.error_description ??
            token?.error ??
            `Google OAuth token exchange failed (${response.status})`
        )
      }

      return token ?? {}
    },
    []
  )

  const handleRedirectCallbackIfPresent = useCallback(async () => {
    const callbackPath = new URL(getGoogleDriveOAuthCallbackUrl()).pathname
    if (window.location.pathname !== callbackPath) {
      return
    }
    const authOperation = captureAuthOperation()

    const params = new URLSearchParams(window.location.search)
    const implicitToken = readImplicitRedirectTokenFromHash()
    const oauthError = params.get('error') ?? implicitToken?.error
    if (oauthError) {
      const attemptedPromptMode = window.localStorage.getItem(
        IMPLICIT_PROMPT_MODE_KEY
      )
      const shouldRetryWithConsent =
        attemptedPromptMode === 'none' &&
        (oauthError === 'interaction_required' ||
          oauthError === 'login_required' ||
          oauthError === 'consent_required')
      if (shouldRetryWithConsent) {
        clearPkceState({ preserveHandoffMode: true })
        const { clientId } = googleClientManager.getOAuthClient()
        if (!clientId?.trim()) {
          throw new Error('Google OAuth client is not configured.')
        }
        const state = globalThis.crypto?.randomUUID
          ? globalThis.crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`
        const returnTo = getAppPath(APP_ROUTE_PATHS.home)

        window.localStorage.setItem(PKCE_STATE_KEY, state)
        window.localStorage.setItem(PKCE_RETURN_TO_KEY, returnTo)
        window.localStorage.setItem(IMPLICIT_PROMPT_MODE_KEY, 'consent')
        window.localStorage.removeItem(PKCE_CODE_VERIFIER_KEY)

        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
        authUrl.searchParams.set('client_id', clientId)
        authUrl.searchParams.set(
          'redirect_uri',
          getGoogleDriveOAuthCallbackUrl()
        )
        authUrl.searchParams.set('response_type', 'token')
        authUrl.searchParams.set('scope', DRIVE_SCOPES.join(' '))
        authUrl.searchParams.set('state', state)
        authUrl.searchParams.set('include_granted_scopes', 'true')
        authUrl.searchParams.set('prompt', 'consent')
        window.location.assign(authUrl.toString())
        return
      }
      const message =
        params.get('error_description') ??
        implicitToken?.errorDescription ??
        `Google OAuth failed: ${oauthError}`
      clearPkceState()
      throw new Error(message)
    }

    const code = params.get('code')
    const state = params.get('state') ?? implicitToken?.state
    const accessToken = implicitToken?.accessToken
    if (!code && !state && !accessToken) {
      return
    }

    const storedState = window.localStorage.getItem(PKCE_STATE_KEY)
    const codeVerifier = window.localStorage.getItem(PKCE_CODE_VERIFIER_KEY)
    const returnTo =
      window.localStorage.getItem(PKCE_RETURN_TO_KEY) ??
      getAppPath(APP_ROUTE_PATHS.home)

    if (!state || !storedState) {
      clearPkceState()
      throw new Error('Google OAuth callback is missing required state.')
    }
    if (state !== storedState) {
      clearPkceState()
      throw new Error('Google OAuth callback state mismatch.')
    }

    if (accessToken) {
      const expiresIn = Number.parseInt(implicitToken?.expiresInRaw ?? '', 10)
      const resolvedExpiresIn =
        Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600
      const handoffMode = window.localStorage.getItem(AUTH_HANDOFF_MODE_KEY)
      assertAuthOperationCurrent(authOperation)
      setAccessToken(accessToken, resolvedExpiresIn, { refreshToken: null })
      clearPkceState()
      if (handoffMode === 'new_tab') {
        window.close()
      }
      window.location.replace(returnTo)
      return
    }

    if (!code || !codeVerifier) {
      clearPkceState()
      throw new Error('Google OAuth callback is missing required PKCE state.')
    }

    const tokenResponse = await exchangeAuthorizationCode(code, codeVerifier)
    assertAuthOperationCurrent(authOperation)
    if (tokenResponse.error || !tokenResponse.access_token) {
      clearPkceState()
      throw new Error(
        tokenResponse.error_description ??
          tokenResponse.error ??
          'Failed to obtain access token'
      )
    }

    setAccessToken(
      tokenResponse.access_token,
      tokenResponse.expires_in ?? 3600,
      {
        refreshToken: tokenResponse.refresh_token,
      }
    )
    const handoffMode = window.localStorage.getItem(AUTH_HANDOFF_MODE_KEY)
    clearPkceState()
    if (handoffMode === 'new_tab') {
      window.close()
    }
    window.location.replace(returnTo)
  }, [
    assertAuthOperationCurrent,
    captureAuthOperation,
    clearPkceState,
    exchangeAuthorizationCode,
    readImplicitRedirectTokenFromHash,
    setAccessToken,
  ])

  const startPkceRedirect = useCallback(
    async (mode: GoogleRedirectUxMode, promptMode?: GoogleOAuthPrompt) => {
      const authOperation = captureAuthOperation()
      const { clientId } = googleClientManager.getOAuthClient()
      if (!clientId?.trim()) {
        throw new Error('Google OAuth client is not configured.')
      }

      const { code_verifier: codeVerifier, code_challenge: codeChallenge } =
        await pkceChallenge()
      assertAuthOperationCurrent(authOperation)
      const state = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`
      const returnTo = getAppPath(APP_ROUTE_PATHS.home)

      window.localStorage.setItem(PKCE_CODE_VERIFIER_KEY, codeVerifier)
      window.localStorage.setItem(PKCE_STATE_KEY, state)
      window.localStorage.setItem(PKCE_RETURN_TO_KEY, returnTo)

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      authUrl.searchParams.set('client_id', clientId)
      authUrl.searchParams.set('redirect_uri', getGoogleDriveOAuthCallbackUrl())
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('scope', DRIVE_SCOPES.join(' '))
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('include_granted_scopes', 'true')
      authUrl.searchParams.set('access_type', 'offline')

      // Force consent only until we obtain a refresh token.
      if (promptMode) {
        authUrl.searchParams.set('prompt', promptMode)
      } else if (!tokenInfoRef.current?.refreshToken) {
        authUrl.searchParams.set('prompt', 'consent')
      }

      openAuthUrl(authUrl, mode)
    },
    [assertAuthOperationCurrent, captureAuthOperation, openAuthUrl]
  )

  const startImplicitRedirect = useCallback(
    (
      promptMode: GoogleOAuthPrompt = 'none',
      mode: GoogleRedirectUxMode = 'new_tab'
    ) => {
      const { clientId } = googleClientManager.getOAuthClient()
      if (!clientId?.trim()) {
        throw new Error('Google OAuth client is not configured.')
      }

      const state = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`
      const returnTo = getAppPath(APP_ROUTE_PATHS.home)

      window.localStorage.setItem(PKCE_STATE_KEY, state)
      window.localStorage.setItem(PKCE_RETURN_TO_KEY, returnTo)
      window.localStorage.setItem(IMPLICIT_PROMPT_MODE_KEY, promptMode)
      window.localStorage.removeItem(PKCE_CODE_VERIFIER_KEY)

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      authUrl.searchParams.set('client_id', clientId)
      authUrl.searchParams.set('redirect_uri', getGoogleDriveOAuthCallbackUrl())
      authUrl.searchParams.set('response_type', 'token')
      authUrl.searchParams.set('scope', DRIVE_SCOPES.join(' '))
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('include_granted_scopes', 'true')
      authUrl.searchParams.set('prompt', promptMode)

      openAuthUrl(authUrl, mode)
    },
    [openAuthUrl]
  )

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    const refreshToken = tokenInfoRef.current?.refreshToken?.trim()
    if (!refreshToken) {
      return null
    }
    const authOperation = captureAuthOperation()

    const { clientId, clientSecret } = googleClientManager.getOAuthClient()
    if (!clientId?.trim()) {
      throw new Error('Google OAuth client is not configured.')
    }

    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
    if (clientSecret?.trim()) {
      body.set('client_secret', clientSecret.trim())
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })

    let token: AccessTokenResponse | null = null
    try {
      token = (await response.json()) as AccessTokenResponse
    } catch {
      token = null
    }
    assertAuthOperationCurrent(authOperation)

    if (!response.ok || token?.error || !token?.access_token) {
      if (token?.error === 'invalid_grant') {
        setAccessToken('')
      }
      throw new Error(
        token?.error_description ??
          token?.error ??
          `Google OAuth refresh failed (${response.status})`
      )
    }

    setAccessToken(token.access_token, token.expires_in ?? 3600, {
      refreshToken: token.refresh_token ?? refreshToken,
    })
    return token.access_token
  }, [assertAuthOperationCurrent, captureAuthOperation, setAccessToken])

  const mintServiceAccountAccessToken = useCallback(async (): Promise<
    string | null
  > => {
    const oauthClient = googleClientManager.getOAuthClient()
    if (oauthClient.authFlow !== 'service_account') {
      return null
    }
    if (!oauthClient.serviceAccount) {
      throw new Error('Google Drive service account credentials are missing.')
    }
    const authOperation = captureAuthOperation()

    const token = await mintGoogleServiceAccountAccessToken(
      oauthClient.serviceAccount,
      DRIVE_SCOPES
    )
    assertAuthOperationCurrent(authOperation)
    setAccessToken(token.access_token, token.expires_in ?? 3600, {
      refreshToken: null,
    })
    return token.access_token
  }, [assertAuthOperationCurrent, captureAuthOperation, setAccessToken])

  useEffect(() => {
    tokenInfoRef.current = tokenInfo
  }, [tokenInfo])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now())
    }, 30_000)
    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  const isDriveSyncing = Boolean(
    tokenInfo?.token && tokenInfo.expiresAt > nowMs
  )

  const canUseCachedToken = useCallback((info: AccessTokenInfo | null) => {
    if (!info?.token || info.expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
      return false
    }
    const authFlow = googleClientManager.getOAuthClient().authFlow
    if (authFlow === 'service_account') {
      return info.authFlow === 'service_account'
    }
    return info.authFlow !== 'service_account'
  }, [])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return
      }
      if (event.key === AUTH_SESSION_EPOCH_KEY) {
        invalidatePendingAuth(
          'Invalidated pending Google Drive authorization after logout in another tab'
        )
        return
      }
      if (event.key !== STORAGE_KEY && event.key !== LEGACY_STORAGE_KEY) {
        return
      }
      invalidatePendingAuth(
        'Invalidated pending Google Drive authorization after credentials changed in another tab'
      )
      const nextTokenInfo = loadStoredToken()
      tokenInfoRef.current = nextTokenInfo
      setTokenInfo(nextTokenInfo)
    }

    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener('storage', handleStorage)
    }
  }, [invalidatePendingAuth])

  useEffect(() => {
    callbackErrorRef.current = null
    const pending = handleRedirectCallbackIfPresent().catch((error) => {
      if (error instanceof StaleGoogleAuthOperationError) {
        return
      }
      callbackErrorRef.current = error
      try {
        window.sessionStorage.setItem(PKCE_ERROR_KEY, String(error))
      } catch {
        // Ignore session storage failures.
      }
      appLogger.error('Failed to handle Google Drive OAuth callback', {
        attrs: {
          scope: 'storage.drive.auth',
          code: 'DRIVE_AUTH_CALLBACK_FAILED',
          error: String(error),
        },
      })
      const callbackPath = new URL(getGoogleDriveOAuthCallbackUrl()).pathname
      if (window.location.pathname === callbackPath) {
        window.location.replace(getAppPath(APP_ROUTE_PATHS.home))
      }
    })
    callbackPromiseRef.current = pending.finally(() => {
      callbackPromiseRef.current = null
    })
  }, [handleRedirectCallbackIfPresent])

  // Loads the Google Identity Services script exactly once. We memoise the
  // function so callers share the same pending promise, and we stash the promise
  // itself in scriptPromiseRef so multiple callers can await the same work.
  const ensureScriptLoaded = useCallback(() => {
    if (window.google?.accounts?.oauth2?.initTokenClient) {
      return Promise.resolve()
    }

    if (!scriptPromiseRef.current) {
      scriptPromiseRef.current = new Promise<void>((resolve, reject) => {
        const existingScript = document.querySelector<HTMLScriptElement>(
          'script[src="https://accounts.google.com/gsi/client"]'
        )

        if (existingScript) {
          existingScript.addEventListener('load', () => resolve(), {
            once: true,
          })
          existingScript.addEventListener('error', reject, { once: true })
          return
        }

        const script = document.createElement('script')
        script.src = 'https://accounts.google.com/gsi/client'
        script.async = true
        script.defer = true
        script.onload = () => resolve()
        script.onerror = reject
        document.head.appendChild(script)
      }).finally(() => {
        scriptPromiseRef.current = null
      })
    }

    return scriptPromiseRef.current
  }, [])

  // Lazily create the OAuth token client. We only initialise the client when a
  // consumer actually asks for a token. The client instance is cached in a ref
  // so subsequent callers reuse the same object.
  const ensureTokenClient = useCallback(async () => {
    const { clientId } = googleClientManager.getOAuthClient()
    if (!clientId?.trim()) {
      throw new Error('Google OAuth client is not configured.')
    }
    if (tokenClientRef.current && oauthClientIdRef.current === clientId) {
      return tokenClientRef.current
    }
    tokenClientRef.current = null
    oauthClientIdRef.current = clientId
    const authOperation = captureAuthOperation()

    await ensureScriptLoaded()
    assertAuthOperationCurrent(authOperation)

    const oauth = window.google?.accounts?.oauth2
    if (!oauth?.initTokenClient) {
      throw new Error('Google OAuth client is not available.')
    }

    const client = oauth.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPES.join(' '),
      callback: (response: AccessTokenResponse) => {
        try {
          assertAuthOperationCurrent(authOperation)
        } catch (error) {
          if (error instanceof StaleGoogleAuthOperationError) {
            return
          }
          throw error
        }
        if (!handlersRef.current) {
          return
        }
        const { resolve, reject } = handlersRef.current
        handlersRef.current = null
        if (response.error || !response.access_token) {
          reject(response.error ?? new Error('Failed to obtain access token'))
          return
        }
        setAccessToken(response.access_token, response.expires_in ?? 3600)
        resolve(response.access_token)
      },
    })

    tokenClientRef.current = client
    return client
  }, [
    assertAuthOperationCurrent,
    captureAuthOperation,
    ensureScriptLoaded,
    setAccessToken,
  ])

  const logoutGoogleDrive = useCallback(async () => {
    const oauthClient = googleClientManager.getOAuthClient()
    const accessToken = tokenInfoRef.current?.token

    advanceAuthSessionEpoch()
    invalidatePendingAuth(
      'Invalidated pending Google Drive authorization during logout'
    )
    callbackErrorRef.current = null
    clearPkceState()
    setAccessToken('')
    window.gapi?.client.setToken(null)

    if (oauthClient.authFlow !== 'service_account') {
      requestAccountSelectionNext()
    }

    if (!accessToken || oauthClient.authFlow === 'service_account') {
      return
    }

    try {
      await ensureScriptLoaded()
      const revoke = window.google?.accounts?.oauth2?.revoke
      if (!revoke) {
        return
      }
      await new Promise<void>((resolve) => {
        revoke(accessToken, resolve)
      })
    } catch (error) {
      // Local credentials have already been cleared. Revocation is best effort
      // because a network failure should not leave the app signed in.
      appLogger.warn('Failed to revoke Google Drive access token', {
        attrs: {
          scope: 'storage.drive.auth',
          code: 'DRIVE_AUTH_TOKEN_REVOKE_FAILED',
          error: String(error),
        },
      })
    }
  }, [
    advanceAuthSessionEpoch,
    clearPkceState,
    ensureScriptLoaded,
    invalidatePendingAuth,
    requestAccountSelectionNext,
    setAccessToken,
  ])

  const startGoogleDriveOAuth = useCallback(
    async (
      options?: StartGoogleDriveOAuthOptions
    ): Promise<StartGoogleDriveOAuthResult> => {
      const oauthClient = googleClientManager.getOAuthClient()
      const requestedMode = options?.mode ?? oauthClient.authUxMode

      invalidatePendingAuth(
        'Invalidated pending Google Drive authorization before starting a fresh flow'
      )
      clearPkceState()
      const authOperation = captureAuthOperation()

      if (oauthClient.authFlow === 'service_account') {
        const accessToken = await mintServiceAccountAccessToken()
        if (!accessToken) {
          throw new Error(
            'Google Drive service account credentials are missing.'
          )
        }
        return {
          status: 'authorized',
          authFlow: oauthClient.authFlow,
          mode: oauthClient.authUxMode,
          accessToken,
        }
      }

      const promptMode = consumeAccountSelectionRequest()
        ? 'select_account'
        : options?.prompt

      if (oauthClient.authFlow === 'pkce') {
        const mode: GoogleRedirectUxMode =
          requestedMode === 'redirect' ? 'redirect' : 'new_tab'
        await startPkceRedirect(mode, promptMode)
        return {
          status: 'started',
          authFlow: oauthClient.authFlow,
          mode,
        }
      }

      if (requestedMode === 'redirect' || requestedMode === 'new_tab') {
        startImplicitRedirect(promptMode ?? 'none', requestedMode)
        return {
          status: 'started',
          authFlow: oauthClient.authFlow,
          mode: requestedMode,
        }
      }

      const client = await ensureTokenClient()
      assertAuthOperationCurrent(authOperation)
      const accessToken = await new Promise<string>((resolve, reject) => {
        handlersRef.current = { resolve, reject }
        client.callback = (response: AccessTokenResponse) => {
          try {
            assertAuthOperationCurrent(authOperation)
          } catch (error) {
            if (error instanceof StaleGoogleAuthOperationError) {
              return
            }
            throw error
          }
          if (!handlersRef.current) {
            return
          }
          const { resolve: pendingResolve, reject: pendingReject } =
            handlersRef.current
          handlersRef.current = null

          if (response.error || !response.access_token) {
            pendingReject(
              response.error ?? new Error('Failed to obtain access token')
            )
            return
          }
          setAccessToken(response.access_token, response.expires_in ?? 3600)
          pendingResolve(response.access_token)
        }
        try {
          client.requestAccessToken({ prompt: promptMode ?? 'none' })
        } catch (error) {
          handlersRef.current = null
          reject(error)
        }
      })

      return {
        status: 'authorized',
        authFlow: oauthClient.authFlow,
        mode: 'popup',
        accessToken,
      }
    },
    [
      assertAuthOperationCurrent,
      captureAuthOperation,
      clearPkceState,
      consumeAccountSelectionRequest,
      ensureTokenClient,
      invalidatePendingAuth,
      mintServiceAccountAccessToken,
      setAccessToken,
      startImplicitRedirect,
      startPkceRedirect,
    ]
  )

  useEffect(() => {
    appState.setGoogleDriveOAuthHandler(startGoogleDriveOAuth)
    return () => {
      appState.setGoogleDriveOAuthHandler(null)
    }
  }, [startGoogleDriveOAuth])

  // Public entry point: fetch (or reuse) an access token. The callback contains
  // all of the state orchestration so Callers can simply `await`.
  const ensureAccessToken = useCallback(
    (options?: EnsureAccessTokenOptions) => {
      const interactive = options?.interactive ?? true
      const currentInfo = tokenInfoRef.current
      if (currentInfo && canUseCachedToken(currentInfo)) {
        return Promise.resolve(currentInfo.token)
      }

      if (pendingPromiseRef.current) {
        return pendingPromiseRef.current
      }

      const authOperation = captureAuthOperation()
      const pendingPromise = (async () => {
        if (callbackPromiseRef.current) {
          await callbackPromiseRef.current
          assertAuthOperationCurrent(authOperation)
        }
        let callbackErrorFromStorage: string | null = null
        try {
          callbackErrorFromStorage =
            window.sessionStorage.getItem(PKCE_ERROR_KEY)
          if (callbackErrorFromStorage) {
            window.sessionStorage.removeItem(PKCE_ERROR_KEY)
          }
        } catch {
          callbackErrorFromStorage = null
        }
        if (callbackErrorFromStorage) {
          throw new Error(callbackErrorFromStorage)
        }
        if (callbackErrorRef.current) {
          const callbackError = callbackErrorRef.current
          callbackErrorRef.current = null
          throw callbackError
        }

        const refreshedInfo = tokenInfoRef.current
        if (refreshedInfo && canUseCachedToken(refreshedInfo)) {
          return refreshedInfo.token
        }

        const serviceAccountToken = await mintServiceAccountAccessToken()
        assertAuthOperationCurrent(authOperation)
        if (serviceAccountToken) {
          return serviceAccountToken
        }

        try {
          const refreshedToken = await refreshAccessToken()
          if (refreshedToken) {
            return refreshedToken
          }
        } catch (error) {
          if (error instanceof StaleGoogleAuthOperationError) {
            throw error
          }
          assertAuthOperationCurrent(authOperation)
          appLogger.error('Failed to refresh Google access token', {
            attrs: {
              scope: 'storage.drive.auth',
              code: 'DRIVE_AUTH_TOKEN_REFRESH_FAILED',
              error: String(error),
            },
          })
          if (!interactive) {
            throw new Error(
              `Google Drive authorization is required: ${String(error)}`
            )
          }
        }

        if (!interactive) {
          throw new Error('Google Drive authorization is required.')
        }

        assertAuthOperationCurrent(authOperation)
        const oauthClient = googleClientManager.getOAuthClient()
        if (hasRedirectAuthHandoffInProgress()) {
          throw new Error(
            'Redirecting to Google OAuth for Drive authorization.'
          )
        }
        if (oauthClient.authFlow === 'pkce') {
          const promptMode = consumeAccountSelectionRequest()
            ? 'select_account'
            : undefined
          await startPkceRedirect(
            oauthClient.authUxMode === 'redirect' ? 'redirect' : 'new_tab',
            promptMode
          )
          throw new Error(
            'Redirecting to Google OAuth for Drive authorization.'
          )
        }
        if (oauthClient.authUxMode === 'redirect') {
          const promptMode = consumeAccountSelectionRequest()
            ? 'select_account'
            : 'none'
          startImplicitRedirect(promptMode, 'redirect')
          throw new Error(
            'Redirecting to Google OAuth for Drive authorization.'
          )
        }
        if (oauthClient.authUxMode === 'new_tab') {
          const promptMode = consumeAccountSelectionRequest()
            ? 'select_account'
            : 'none'
          startImplicitRedirect(promptMode, 'new_tab')
          throw new Error(
            'Redirecting to Google OAuth for Drive authorization.'
          )
        }

        const client = await ensureTokenClient()
        assertAuthOperationCurrent(authOperation)
        return await new Promise<string>((resolve, reject) => {
          handlersRef.current = { resolve, reject }
          client.callback = (response: AccessTokenResponse) => {
            try {
              assertAuthOperationCurrent(authOperation)
            } catch (error) {
              if (error instanceof StaleGoogleAuthOperationError) {
                return
              }
              throw error
            }
            if (!handlersRef.current) {
              return
            }
            const { resolve: pendingResolve, reject: pendingReject } =
              handlersRef.current
            handlersRef.current = null

            if (response.error || !response.access_token) {
              pendingReject(
                response.error ?? new Error('Failed to obtain access token')
              )
              return
            }
            setAccessToken(response.access_token, response.expires_in ?? 3600)
            pendingResolve(response.access_token)
          }
          try {
            console.log('Requesting access token from Google OAuth')
            client.requestAccessToken({
              prompt: consumeAccountSelectionRequest()
                ? 'select_account'
                : currentInfo?.token
                  ? ''
                  : 'consent',
            })
          } catch (error) {
            handlersRef.current = null
            appLogger.error('Failed to request Google access token', {
              attrs: {
                scope: 'storage.drive.auth',
                code: 'DRIVE_AUTH_TOKEN_REQUEST_FAILED',
                error: String(error),
              },
            })
            reject(error)
          }
        })
      })()
      pendingPromiseRef.current = pendingPromise
      void pendingPromise.then(
        () => {
          if (pendingPromiseRef.current === pendingPromise) {
            pendingPromiseRef.current = null
          }
        },
        () => {
          if (pendingPromiseRef.current === pendingPromise) {
            pendingPromiseRef.current = null
          }
        }
      )

      return pendingPromise
    },
    [
      assertAuthOperationCurrent,
      canUseCachedToken,
      captureAuthOperation,
      consumeAccountSelectionRequest,
      ensureTokenClient,
      hasRedirectAuthHandoffInProgress,
      mintServiceAccountAccessToken,
      refreshAccessToken,
      setAccessToken,
      startImplicitRedirect,
      startPkceRedirect,
    ]
  )

  // useMemo caches the context value so React hands the same object reference to
  // consumers unless one of the dependencies changes. This prevents needless
  // rerenders in deep trees that subscribe to the context.
  const value = useMemo(
    () => ({
      ensureAccessToken,
      isDriveSyncing,
      logoutGoogleDrive,
      startGoogleDriveOAuth,
      setAccessToken,
    }),
    [
      ensureAccessToken,
      isDriveSyncing,
      logoutGoogleDrive,
      startGoogleDriveOAuth,
      setAccessToken,
    ]
  )

  return (
    <GoogleAuthContext.Provider value={value}>
      {children}
    </GoogleAuthContext.Provider>
  )
}
