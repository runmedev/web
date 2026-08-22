export type AppLoginMode = 'principal' | 'service_account'
export type IdentitySharingMode = 'shared' | 'separate'

export interface AppLoginConfiguration {
  identitySharing: IdentitySharingMode
  mode: AppLoginMode
  humanAccount: string
  serviceAccount: string
  driveMode: AppLoginMode
  driveHumanAccount: string
  driveServiceAccount: string
}

export const APP_LOGIN_CONFIGURATION_STORAGE_KEY =
  'runme/app-login-configuration'
export const APP_LOGIN_CONFIGURATION_CHANGED_EVENT =
  'runme-app-login-configuration-changed'
const STORAGE_KEY = APP_LOGIN_CONFIGURATION_STORAGE_KEY

export interface EffectiveDriveLoginConfiguration {
  mode: AppLoginMode
  humanAccount: string
  serviceAccount: string
}

export const DEFAULT_APP_LOGIN_CONFIGURATION: AppLoginConfiguration = {
  identitySharing: 'shared',
  mode: 'principal',
  humanAccount: '',
  serviceAccount: '',
  driveMode: 'principal',
  driveHumanAccount: '',
  driveServiceAccount: '',
}

function readMode(value: unknown): AppLoginMode {
  return value === 'service_account' ? 'service_account' : 'principal'
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
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
      identitySharing:
        parsed.identitySharing === 'separate' ? 'separate' : 'shared',
      mode: readMode(parsed.mode),
      humanAccount: readText(parsed.humanAccount),
      serviceAccount: readText(parsed.serviceAccount),
      driveMode: readMode(parsed.driveMode),
      driveHumanAccount: readText(parsed.driveHumanAccount),
      driveServiceAccount: readText(parsed.driveServiceAccount),
    }
  } catch {
    return DEFAULT_APP_LOGIN_CONFIGURATION
  }
}

export function saveAppLoginConfiguration(
  configuration: AppLoginConfiguration
): AppLoginConfiguration {
  const normalized: AppLoginConfiguration = {
    identitySharing: configuration.identitySharing,
    mode: configuration.mode,
    humanAccount: configuration.humanAccount.trim(),
    serviceAccount: configuration.serviceAccount.trim(),
    driveMode: configuration.driveMode,
    driveHumanAccount: configuration.driveHumanAccount.trim(),
    driveServiceAccount: configuration.driveServiceAccount.trim(),
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  window.dispatchEvent(new Event(APP_LOGIN_CONFIGURATION_CHANGED_EVENT))
  return normalized
}

export function resolveDriveLoginConfiguration(
  configuration: AppLoginConfiguration
): EffectiveDriveLoginConfiguration {
  if (configuration.identitySharing === 'shared') {
    return {
      mode: configuration.mode,
      humanAccount: configuration.humanAccount,
      serviceAccount: configuration.serviceAccount,
    }
  }
  return {
    mode: configuration.driveMode,
    humanAccount: configuration.driveHumanAccount,
    serviceAccount: configuration.driveServiceAccount,
  }
}

export function isGoogleServiceAccountEmail(value: string): boolean {
  // The host segment is the immutable Google Cloud project ID, not a DNS
  // name. Project IDs are 6-30 lowercase letters, digits, or hyphens; they
  // start with a letter and end with a letter or digit. Rejecting dots here
  // prevents a confusing IAM Credentials `Gaia id not found` response.
  return /^[^@\s]+@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(
    value.trim()
  )
}
