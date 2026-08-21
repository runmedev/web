export type AppLoginMode = 'principal' | 'service_account'

export interface AppLoginConfiguration {
  mode: AppLoginMode
  serviceAccount: string
}

const STORAGE_KEY = 'runme/app-login-configuration'

export const DEFAULT_APP_LOGIN_CONFIGURATION: AppLoginConfiguration = {
  mode: 'principal',
  serviceAccount: '',
}

export function readAppLoginConfiguration(): AppLoginConfiguration {
  if (typeof window === 'undefined') {
    return DEFAULT_APP_LOGIN_CONFIGURATION
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (!stored) {
      return DEFAULT_APP_LOGIN_CONFIGURATION
    }
    const parsed = JSON.parse(stored) as Partial<AppLoginConfiguration>
    return {
      mode: parsed.mode === 'service_account' ? 'service_account' : 'principal',
      serviceAccount:
        typeof parsed.serviceAccount === 'string'
          ? parsed.serviceAccount.trim()
          : '',
    }
  } catch {
    return DEFAULT_APP_LOGIN_CONFIGURATION
  }
}

export function saveAppLoginConfiguration(
  configuration: AppLoginConfiguration
): AppLoginConfiguration {
  const normalized = {
    mode: configuration.mode,
    serviceAccount: configuration.serviceAccount.trim(),
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  return normalized
}

export function isGoogleServiceAccountEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/i.test(value.trim())
}
