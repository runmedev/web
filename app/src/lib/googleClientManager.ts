import type { GoogleServiceAccountCredentials } from '../auth/googleServiceAccount'

export type GoogleOAuthClientConfig = {
  clientId: string
  clientSecret?: string
  authFlow: GoogleDriveAuthFlow
  authUxMode: GoogleDriveAuthUxMode
  serviceAccount?: GoogleServiceAccountCredentials
}

export type GoogleDrivePickerConfig = {
  clientId: string
  developerKey: string
  appId: string
}

export const GOOGLE_CLIENT_STORAGE_KEY = 'googleClientConfig'
const STORAGE_KEY = GOOGLE_CLIENT_STORAGE_KEY

export type GoogleDriveAuthFlow = 'implicit' | 'pkce' | 'service_account'
export type GoogleDriveAuthUxMode = 'popup' | 'redirect' | 'new_tab'

const DEFAULT_AUTH_FLOW: GoogleDriveAuthFlow = 'implicit'
const DEFAULT_AUTH_UX_MODE_FOR_FLOW: Record<
  GoogleDriveAuthFlow,
  GoogleDriveAuthUxMode
> = {
  implicit: 'new_tab',
  pkce: 'new_tab',
  service_account: 'new_tab',
}

function isGoogleDriveAuthFlow(value: unknown): value is GoogleDriveAuthFlow {
  return value === 'implicit' || value === 'pkce' || value === 'service_account'
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

type ServiceAccountJson = {
  client_email?: string
  clientEmail?: string
  private_key?: string
  privateKey?: string
  private_key_id?: string
  privateKeyId?: string
  token_uri?: string
  tokenUri?: string
  subject?: string
  scopes?: unknown
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const values = value.filter(
    (scope): scope is string =>
      typeof scope === 'string' && scope.trim().length > 0
  )
  return values.length > 0 ? values : undefined
}

function parseServiceAccountCredentials(
  value: ServiceAccountJson | null | undefined
): GoogleServiceAccountCredentials | undefined {
  const clientEmail = (value?.client_email ?? value?.clientEmail ?? '').trim()
  const privateKey = (value?.private_key ?? value?.privateKey ?? '').trim()
  if (!clientEmail && !privateKey) {
    return undefined
  }
  return {
    clientEmail,
    privateKey,
    privateKeyId:
      (value?.private_key_id ?? value?.privateKeyId ?? '').trim() || undefined,
    tokenUri: (value?.token_uri ?? value?.tokenUri ?? '').trim() || undefined,
    subject: value?.subject?.trim() || undefined,
    scopes: parseStringArray(value?.scopes),
  }
}

function isCompleteServiceAccountCredentials(
  value: GoogleServiceAccountCredentials | undefined
): value is GoogleServiceAccountCredentials {
  return Boolean(value?.clientEmail.trim() && value.privateKey.trim())
}

function serializeServiceAccountCredentials(
  value: GoogleServiceAccountCredentials
): ServiceAccountJson {
  return {
    clientEmail: value.clientEmail,
    privateKey: value.privateKey,
    privateKeyId: value.privateKeyId,
    tokenUri: value.tokenUri,
    subject: value.subject,
    scopes: value.scopes,
  }
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
    const storedServiceAccount = this.readOAuthServiceAccountFromStorage()
    const resolvedClientId = storedClientId ?? defaultClientId
    const resolvedClientSecret = storedClientSecret ?? undefined
    const resolvedAuthFlow =
      storedAuthFlow === 'service_account' && storedServiceAccount
        ? 'service_account'
        : storedAuthFlow === 'service_account'
          ? DEFAULT_AUTH_FLOW
          : (storedAuthFlow ??
            (storedServiceAccount ? 'service_account' : DEFAULT_AUTH_FLOW))
    const resolvedAuthUxMode =
      storedAuthUxMode ?? resolveDefaultUxModeForFlow(resolvedAuthFlow)
    const oauth: GoogleOAuthClientConfig = {
      clientId: resolvedClientId,
      clientSecret: resolvedClientSecret,
      authFlow: resolvedAuthFlow,
      authUxMode: resolvedAuthUxMode,
    }
    if (resolvedAuthFlow === 'service_account' && storedServiceAccount) {
      oauth.serviceAccount = storedServiceAccount
    }
    this.config = {
      oauth,
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

    const serviceAccount =
      nextAuthFlow === 'service_account'
        ? (config.serviceAccount ?? this.config.oauth.serviceAccount)
        : undefined

    const nextOAuthClient: GoogleOAuthClientConfig = {
      ...this.config.oauth,
      ...config,
      authFlow: nextAuthFlow,
      authUxMode: nextAuthUxMode,
    }
    if (serviceAccount) {
      nextOAuthClient.serviceAccount = serviceAccount
    } else {
      delete nextOAuthClient.serviceAccount
    }
    this.config.oauth = nextOAuthClient
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
      service_account?: ServiceAccountJson
      serviceAccount?: ServiceAccountJson
      client_email?: string
      clientEmail?: string
      private_key?: string
      privateKey?: string
      private_key_id?: string
      privateKeyId?: string
      token_uri?: string
      tokenUri?: string
      subject?: string
      scopes?: unknown
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
        service_account?: ServiceAccountJson
        serviceAccount?: ServiceAccountJson
        client_email?: string
        clientEmail?: string
        private_key?: string
        privateKey?: string
        private_key_id?: string
        privateKeyId?: string
        token_uri?: string
        tokenUri?: string
        subject?: string
        scopes?: unknown
      }
    } catch {
      throw new Error('Invalid JSON: unable to parse OAuth client config')
    }

    const clientId = (parsed?.client_id ?? parsed?.clientId ?? '').trim()
    const serviceAccount = parseServiceAccountCredentials(
      parsed?.service_account ?? parsed?.serviceAccount ?? parsed
    )
    if (!clientId && !serviceAccount) {
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
    const resolvedAuthFlow =
      (rawAuthFlow?.trim() as GoogleDriveAuthFlow | undefined) ??
      (serviceAccount ? 'service_account' : undefined)

    return this.setOAuthClient({
      clientId,
      clientSecret: clientSecret.length > 0 ? clientSecret : undefined,
      authFlow: resolvedAuthFlow,
      authUxMode: rawAuthUxMode?.trim() as GoogleDriveAuthUxMode | undefined,
      serviceAccount,
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
      if (!authFlow || !isGoogleDriveAuthFlow(authFlow)) {
        return null
      }
      return authFlow
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

  private readOAuthServiceAccountFromStorage(): GoogleServiceAccountCredentials | null {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        return null
      }
      const parsed = JSON.parse(raw) as {
        oauthServiceAccount?: ServiceAccountJson
        serviceAccount?: ServiceAccountJson
      } | null
      const serviceAccount = parseServiceAccountCredentials(
        parsed?.oauthServiceAccount ?? parsed?.serviceAccount
      )
      return isCompleteServiceAccountCredentials(serviceAccount)
        ? serviceAccount
        : null
    } catch (error) {
      console.warn('Failed to read Google service account config', error)
      return null
    }
  }

  private persistOAuthClient(config: GoogleOAuthClientConfig): void {
    if (typeof window === 'undefined' || !window.localStorage) {
      return
    }
    try {
      const serviceAccount =
        config.authFlow === 'service_account' && config.serviceAccount
          ? serializeServiceAccountCredentials(config.serviceAccount)
          : undefined
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          oauthClientId: config.clientId,
          oauthClientSecret: config.clientSecret,
          oauthAuthFlow: config.authFlow,
          oauthAuthUxMode: config.authUxMode,
          oauthServiceAccount: serviceAccount,
        })
      )
    } catch (error) {
      console.warn('Failed to persist Google OAuth client config', error)
    }
  }
}

export const googleClientManager = GoogleClientManager.instance()
