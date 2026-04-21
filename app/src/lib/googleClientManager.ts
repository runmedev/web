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

function derivePickerAppId(clientId: string): string | null {
  const trimmed = clientId.trim()
  if (!trimmed) {
    return null
  }
  const candidate = trimmed.split('-')[0]?.trim() ?? ''
  return /^\d+$/.test(candidate) ? candidate : null
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
    const storedPickerClientId = this.readDrivePickerClientIdFromStorage()
    const storedClientSecret = this.readOAuthClientSecretFromStorage()
    const storedAuthFlow = this.readOAuthAuthFlowFromStorage()
    const storedAuthUxMode = this.readOAuthAuthUxModeFromStorage()
    const storedDeveloperKey = this.readDrivePickerDeveloperKeyFromStorage()
    const storedAppId = this.readDrivePickerAppIdFromStorage()
    const resolvedClientId =
      storedClientId ?? storedPickerClientId ?? defaultClientId
    const resolvedClientSecret = storedClientSecret ?? undefined
    const resolvedAuthFlow = storedAuthFlow ?? DEFAULT_AUTH_FLOW
    const resolvedAuthUxMode =
      storedAuthUxMode ?? resolveDefaultUxModeForFlow(resolvedAuthFlow)
    const resolvedDrivePickerClientId = storedPickerClientId ?? resolvedClientId
    this.config = {
      oauth: {
        clientId: resolvedClientId,
        clientSecret: resolvedClientSecret,
        authFlow: resolvedAuthFlow,
        authUxMode: resolvedAuthUxMode,
      },
      drivePicker: {
        clientId: resolvedDrivePickerClientId,
        developerKey: storedDeveloperKey ?? '',
        appId:
          storedAppId ??
          derivePickerAppId(resolvedDrivePickerClientId) ??
          'notavalidappid',
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

    const previousDrivePickerClientId = this.config.drivePicker.clientId
    const previousDerivedAppId = derivePickerAppId(previousDrivePickerClientId)
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
        appId:
          this.config.drivePicker.appId === 'notavalidappid' ||
          this.config.drivePicker.appId === previousDerivedAppId
            ? derivePickerAppId(config.clientId) ?? this.config.drivePicker.appId
            : this.config.drivePicker.appId,
      }
    }
    this.persistConfig()
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
    if (config.clientId !== undefined) {
      this.config.oauth = {
        ...this.config.oauth,
        clientId: config.clientId,
      }
    }
    this.config.drivePicker = {
      ...this.config.drivePicker,
      ...config,
    }
    this.persistConfig()
    return this.config.drivePicker
  }

  private readDrivePickerClientIdFromStorage(): string | null {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        return null
      }
      const parsed = JSON.parse(raw) as { drivePickerClientId?: string } | null
      const clientId = parsed?.drivePickerClientId?.trim()
      return clientId && clientId.length > 0 ? clientId : null
    } catch (error) {
      console.warn('Failed to read Google Drive Picker client config', error)
      return null
    }
  }

  private readDrivePickerDeveloperKeyFromStorage(): string | null {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        return null
      }
      const parsed = JSON.parse(raw) as {
        drivePickerDeveloperKey?: string
      } | null
      const developerKey = parsed?.drivePickerDeveloperKey?.trim()
      return developerKey && developerKey.length > 0 ? developerKey : null
    } catch (error) {
      console.warn('Failed to read Google Drive Picker developer key', error)
      return null
    }
  }

  private readDrivePickerAppIdFromStorage(): string | null {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        return null
      }
      const parsed = JSON.parse(raw) as { drivePickerAppId?: string } | null
      const appId = parsed?.drivePickerAppId?.trim()
      return appId && appId.length > 0 ? appId : null
    } catch (error) {
      console.warn('Failed to read Google Drive Picker app id', error)
      return null
    }
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

  private persistConfig(): void {
    if (typeof window === 'undefined' || !window.localStorage) {
      return
    }
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          oauthClientId: this.config.oauth.clientId,
          oauthClientSecret: this.config.oauth.clientSecret,
          oauthAuthFlow: this.config.oauth.authFlow,
          oauthAuthUxMode: this.config.oauth.authUxMode,
          drivePickerClientId: this.config.drivePicker.clientId,
          drivePickerDeveloperKey: this.config.drivePicker.developerKey,
          drivePickerAppId: this.config.drivePicker.appId,
        })
      )
    } catch (error) {
      console.warn('Failed to persist Google OAuth client config', error)
    }
  }
}

export const googleClientManager = GoogleClientManager.instance()
