export type GoogleOAuthClientConfig = {
  clientId: string
  clientSecret?: string
  authFlow: GoogleDriveAuthFlow
  authUxMode: GoogleDriveAuthUxMode
}

export type GoogleDrivePickerConfig = {
  clientId: string
  developerKey: string
  appId: string
}

export const GOOGLE_CLIENT_STORAGE_KEY = 'googleClientConfig'
const STORAGE_KEY = GOOGLE_CLIENT_STORAGE_KEY

export type GoogleDriveAuthFlow = 'implicit' | 'pkce'
export type GoogleDriveAuthUxMode = 'popup' | 'redirect' | 'new_tab'

const DEFAULT_AUTH_FLOW: GoogleDriveAuthFlow = 'implicit'
const DEFAULT_AUTH_UX_MODE_FOR_FLOW: Record<
  GoogleDriveAuthFlow,
  GoogleDriveAuthUxMode
> = {
  implicit: 'new_tab',
  pkce: 'new_tab',
}

function isGoogleDriveAuthFlow(value: unknown): value is GoogleDriveAuthFlow {
  return value === 'implicit' || value === 'pkce'
}

function isGoogleDriveAuthUxMode(
  value: unknown
): value is GoogleDriveAuthUxMode {
  return value === 'popup' || value === 'redirect' || value === 'new_tab'
}

function resolveDefaultUxModeForFlow(
  flow: GoogleDriveAuthFlow
): GoogleDriveAuthUxMode {
  return DEFAULT_AUTH_UX_MODE_FOR_FLOW[flow]
}

type GoogleClientConfig = {
  oauth: GoogleOAuthClientConfig
  drivePicker: GoogleDrivePickerConfig
}

export class GoogleClientManager {
  private static singleton: GoogleClientManager | null = null
  private config: GoogleClientConfig

  private constructor() {
    const defaultClientId = ''
    const storedClientId = this.readOAuthClientIdFromStorage()
    const storedClientSecret = this.readOAuthClientSecretFromStorage()
    const storedAuthFlow = this.readOAuthAuthFlowFromStorage()
    const storedAuthUxMode = this.readOAuthAuthUxModeFromStorage()
    const resolvedClientId = storedClientId ?? defaultClientId
    const resolvedClientSecret = storedClientSecret ?? undefined
    const resolvedAuthFlow = storedAuthFlow ?? DEFAULT_AUTH_FLOW
    const resolvedAuthUxMode =
      storedAuthUxMode ?? resolveDefaultUxModeForFlow(resolvedAuthFlow)
    this.config = {
      oauth: {
        clientId: resolvedClientId,
        clientSecret: resolvedClientSecret,
        authFlow: resolvedAuthFlow,
        authUxMode: resolvedAuthUxMode,
      },
      drivePicker: {
        clientId: resolvedClientId,
        developerKey: '',
        // TODO(jlewi): Do we still need this
        appId: 'notavalidappid',
      },
    }
  }

  static instance(): GoogleClientManager {
    if (!this.singleton) {
      this.singleton = new GoogleClientManager()
    }
    return this.singleton
  }

  getOAuthClient(): GoogleOAuthClientConfig {
    return this.config.oauth
  }

  setClientId(clientId: string): GoogleOAuthClientConfig {
    return this.setOAuthClient({ clientId })
  }

  setOAuthClient(
    config: Partial<GoogleOAuthClientConfig>
  ): GoogleOAuthClientConfig {
    const requestedAuthFlow = config.authFlow
    if (requestedAuthFlow && !isGoogleDriveAuthFlow(requestedAuthFlow)) {
      throw new Error(
        `Unsupported Google Drive auth flow: ${String(requestedAuthFlow)}`
      )
    }
    const requestedAuthUxMode = config.authUxMode
    if (requestedAuthUxMode && !isGoogleDriveAuthUxMode(requestedAuthUxMode)) {
      throw new Error(
        `Unsupported Google Drive auth UX mode: ${String(requestedAuthUxMode)}`
      )
    }
    const nextAuthFlow = requestedAuthFlow ?? this.config.oauth.authFlow
    const nextAuthUxMode =
      requestedAuthUxMode ??
      (requestedAuthFlow
        ? resolveDefaultUxModeForFlow(nextAuthFlow)
        : this.config.oauth.authUxMode)

    this.config.oauth = {
      ...this.config.oauth,
      ...config,
      authFlow: nextAuthFlow,
      authUxMode: nextAuthUxMode,
    }
    if (config.clientId !== undefined) {
      this.config.drivePicker = {
        ...this.config.drivePicker,
        clientId: config.clientId,
      }
    }
    this.persistOAuthClient(this.config.oauth)
    return this.config.oauth
  }

  setClientSecret(clientSecret: string): GoogleOAuthClientConfig {
    return this.setOAuthClient({ clientSecret })
  }

  setAuthFlow(authFlow: GoogleDriveAuthFlow): GoogleOAuthClientConfig {
    return this.setOAuthClient({ authFlow })
  }

  setAuthUxMode(authUxMode: GoogleDriveAuthUxMode): GoogleOAuthClientConfig {
    return this.setOAuthClient({ authUxMode })
  }

  setOAuthClientFromJson(raw: string): GoogleOAuthClientConfig {
    let parsed: {
      client_id?: string
      clientId?: string
      client_secret?: string
      auth_flow?: string
      authFlow?: string
      oauthFlow?: string
      flow?: string
      auth_ux_mode?: string
      authUxMode?: string
      oauthUxMode?: string
      uxMode?: string
    } | null = null
    try {
      parsed = JSON.parse(raw) as {
        client_id?: string
        clientId?: string
        client_secret?: string
        auth_flow?: string
        authFlow?: string
        oauthFlow?: string
        flow?: string
        auth_ux_mode?: string
        authUxMode?: string
        oauthUxMode?: string
        uxMode?: string
      }
    } catch {
      throw new Error('Invalid JSON: unable to parse OAuth client config')
    }

    const clientId = (parsed?.client_id ?? parsed?.clientId ?? '').trim()
    if (!clientId) {
      throw new Error('OAuth client config is missing client_id')
    }
    const clientSecret = parsed?.client_secret?.trim() ?? ''
    const rawAuthFlow =
      parsed?.auth_flow ?? parsed?.authFlow ?? parsed?.oauthFlow ?? parsed?.flow
    const rawAuthUxMode =
      parsed?.auth_ux_mode ??
      parsed?.authUxMode ??
      parsed?.oauthUxMode ??
      parsed?.uxMode
    if (
      rawAuthFlow !== undefined &&
      !isGoogleDriveAuthFlow(rawAuthFlow?.trim())
    ) {
      throw new Error(`Unsupported auth_flow value: ${String(rawAuthFlow)}`)
    }
    if (
      rawAuthUxMode !== undefined &&
      !isGoogleDriveAuthUxMode(rawAuthUxMode?.trim())
    ) {
      throw new Error(
        `Unsupported auth_ux_mode value: ${String(rawAuthUxMode)}`
      )
    }

    return this.setOAuthClient({
      clientId,
      clientSecret: clientSecret.length > 0 ? clientSecret : undefined,
      authFlow: rawAuthFlow?.trim() as GoogleDriveAuthFlow | undefined,
      authUxMode: rawAuthUxMode?.trim() as GoogleDriveAuthUxMode | undefined,
    })
  }

  getDrivePickerConfig(): GoogleDrivePickerConfig {
    return this.config.drivePicker
  }

  setDrivePickerConfig(
    config: Partial<GoogleDrivePickerConfig>
  ): GoogleDrivePickerConfig {
    this.config.drivePicker = {
      ...this.config.drivePicker,
      ...config,
    }
    return this.config.drivePicker
  }

  private readOAuthClientIdFromStorage(): string | null {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        return null
      }
      const parsed = JSON.parse(raw) as { oauthClientId?: string } | null
      const clientId = parsed?.oauthClientId?.trim()
      return clientId && clientId.length > 0 ? clientId : null
    } catch (error) {
      console.warn('Failed to read Google OAuth client config', error)
      return null
    }
  }

  private readOAuthClientSecretFromStorage(): string | null {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        return null
      }
      const parsed = JSON.parse(raw) as { oauthClientSecret?: string } | null
      const clientSecret = parsed?.oauthClientSecret?.trim()
      return clientSecret && clientSecret.length > 0 ? clientSecret : null
    } catch (error) {
      console.warn('Failed to read Google OAuth client config', error)
      return null
    }
  }

  private readOAuthAuthFlowFromStorage(): GoogleDriveAuthFlow | null {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        return null
      }
      const parsed = JSON.parse(raw) as { oauthAuthFlow?: string } | null
      const authFlow = parsed?.oauthAuthFlow?.trim()
      return authFlow && isGoogleDriveAuthFlow(authFlow) ? authFlow : null
    } catch (error) {
      console.warn('Failed to read Google OAuth auth flow', error)
      return null
    }
  }

  private readOAuthAuthUxModeFromStorage(): GoogleDriveAuthUxMode | null {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        return null
      }
      const parsed = JSON.parse(raw) as { oauthAuthUxMode?: string } | null
      const authUxMode = parsed?.oauthAuthUxMode?.trim()
      return authUxMode && isGoogleDriveAuthUxMode(authUxMode)
        ? authUxMode
        : null
    } catch (error) {
      console.warn('Failed to read Google OAuth auth UX mode', error)
      return null
    }
  }

  private persistOAuthClient(config: GoogleOAuthClientConfig): void {
    if (typeof window === 'undefined' || !window.localStorage) {
      return
    }
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          oauthClientId: config.clientId,
          oauthClientSecret: config.clientSecret,
          oauthAuthFlow: config.authFlow,
          oauthAuthUxMode: config.authUxMode,
        })
      )
    } catch (error) {
      console.warn('Failed to persist Google OAuth client config', error)
    }
  }
}

export const googleClientManager = GoogleClientManager.instance()
