import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { jwtDecode } from 'jwt-decode'
import { useCallback, useMemo, useState, type ReactNode } from 'react'

import {
  isGoogleServiceAccountEmail,
  readAppLoginConfiguration,
  saveAppLoginConfiguration,
  type AppLoginMode,
} from '../../auth/appLoginConfiguration'
import { oidcConfigManager } from '../../auth/oidcConfig'
import {
  getBrowserAdapter,
  useBrowserAuthData,
} from '../../browserAdapter.client'
import { useGoogleAuth } from '../../contexts/GoogleAuthContext'
import {
  googleClientManager,
  type GoogleDriveAuthFlow,
  type GoogleDriveAuthUxMode,
} from '../../lib/googleClientManager'
import { getGoogleDriveOAuthCallbackUrl } from '../../lib/appBase'
import { showToast } from '../../lib/toast'

const inputClass =
  'w-full rounded-nb-sm border border-nb-border bg-white px-2.5 py-2 text-sm text-nb-text outline-none focus:border-nb-accent focus:ring-2 focus:ring-nb-accent-soft disabled:bg-nb-surface-2 disabled:text-nb-text-faint'
const labelClass = 'block text-xs font-semibold text-nb-text-muted'
const helpClass = 'mt-1 text-xs leading-5 text-nb-text-faint'
const sectionClass = 'border-b border-nb-border px-4 py-4'

type TokenClaims = {
  email?: string
  sub?: string
}

function currentRunmeAccount(idToken?: string): string | null {
  if (!idToken) {
    return null
  }
  try {
    const claims = jwtDecode<TokenClaims>(idToken)
    return claims.email?.trim() || claims.sub?.trim() || null
  } catch {
    return null
  }
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className={sectionClass}>
      <h3 className="text-sm font-semibold text-nb-text">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-nb-text-muted">{description}</p>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  )
}

export default function AuthenticationSettingsPanel() {
  const authData = useBrowserAuthData()
  const browserAdapter = getBrowserAdapter()
  const {
    driveAccount,
    getServiceAccountCredentials,
    isDriveSyncing,
    logoutGoogleDrive,
    setDriveAccount,
    startGoogleDriveOAuth,
  } = useGoogleAuth()

  const initialLogin = useMemo(readAppLoginConfiguration, [])
  const initialDriveOAuth = useMemo(
    () => googleClientManager.getOAuthClient(),
    []
  )
  const initialOidc = useMemo(() => oidcConfigManager.getConfigForEditing(), [])

  const [loginMode, setLoginMode] = useState<AppLoginMode>(initialLogin.mode)
  const [serviceAccount, setServiceAccount] = useState(
    initialLogin.serviceAccount
  )
  const [preferredDriveAccount, setPreferredDriveAccount] = useState(
    driveAccount ?? ''
  )
  const [driveAuthFlow, setDriveAuthFlow] = useState<GoogleDriveAuthFlow>(
    initialDriveOAuth.authFlow
  )
  const [driveAuthUxMode, setDriveAuthUxMode] = useState<GoogleDriveAuthUxMode>(
    initialDriveOAuth.authUxMode
  )
  const [driveClientId, setDriveClientId] = useState(initialDriveOAuth.clientId)
  const [driveClientSecret, setDriveClientSecret] = useState(
    initialDriveOAuth.clientSecret ?? ''
  )
  const [runmeDiscoveryUrl, setRunmeDiscoveryUrl] = useState(
    initialOidc.discoveryUrl
  )
  const [runmeClientId, setRunmeClientId] = useState(initialOidc.clientId)
  const [runmeClientSecret, setRunmeClientSecret] = useState(
    initialOidc.clientSecret ?? ''
  )
  const [runmeScope, setRunmeScope] = useState(initialOidc.scope)
  const [busyAction, setBusyAction] = useState<
    'runme' | 'drive' | 'save' | null
  >(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const runmeAccount = currentRunmeAccount(authData?.idToken)
  const effectiveDriveAccount =
    loginMode === 'service_account' && isDriveSyncing
      ? serviceAccount
      : driveAccount
  const serviceAccountValid =
    loginMode === 'principal' || isGoogleServiceAccountEmail(serviceAccount)
  const requiredFieldsPresent = Boolean(
    driveClientId.trim() &&
      runmeDiscoveryUrl.trim() &&
      runmeClientId.trim() &&
      runmeScope.trim()
  )
  const settingsValid = serviceAccountValid && requiredFieldsPresent

  const saveSettings = useCallback((): boolean => {
    if (!serviceAccountValid) {
      setErrorMessage('Enter a valid Google service-account email.')
      return false
    }
    if (!requiredFieldsPresent) {
      setErrorMessage(
        'Google Drive client ID and all required Runme OAuth fields are required.'
      )
      return false
    }
    try {
      saveAppLoginConfiguration({
        mode: loginMode,
        serviceAccount,
      })
      setDriveAccount(preferredDriveAccount)
      googleClientManager.setOAuthClient({
        clientId: driveClientId.trim(),
        clientSecret: driveClientSecret.trim() || undefined,
        authFlow: driveAuthFlow,
        authUxMode: driveAuthUxMode,
      })
      oidcConfigManager.setConfig({
        discoveryUrl: runmeDiscoveryUrl.trim(),
        clientId: runmeClientId.trim(),
        clientSecret: runmeClientSecret.trim() || undefined,
        scope: runmeScope.trim(),
      })
      setErrorMessage(null)
      return true
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
      return false
    }
  }, [
    driveAuthFlow,
    driveAuthUxMode,
    driveClientId,
    driveClientSecret,
    loginMode,
    preferredDriveAccount,
    requiredFieldsPresent,
    runmeClientId,
    runmeClientSecret,
    runmeDiscoveryUrl,
    runmeScope,
    serviceAccount,
    serviceAccountValid,
    setDriveAccount,
  ])

  const authorizeServiceAccount = useCallback(async () => {
    await getServiceAccountCredentials(serviceAccount.trim(), {
      prompt: 'select_account',
      authorizationLeaseSeconds: 24 * 60 * 60,
      accessTokenLifetimeSeconds: 60 * 60,
    })
  }, [getServiceAccountCredentials, serviceAccount])

  const handleSave = useCallback(() => {
    setBusyAction('save')
    if (saveSettings()) {
      showToast({ message: 'Authentication settings saved', tone: 'success' })
    }
    setBusyAction(null)
  }, [saveSettings])

  const handleRunmeAuth = useCallback(async () => {
    if (authData) {
      browserAdapter.logout()
      return
    }
    if (!saveSettings()) {
      return
    }
    setBusyAction('runme')
    setErrorMessage(null)
    try {
      if (loginMode === 'service_account') {
        await authorizeServiceAccount()
      } else {
        await browserAdapter.loginWithRedirect()
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyAction(null)
    }
  }, [
    authData,
    authorizeServiceAccount,
    browserAdapter,
    loginMode,
    saveSettings,
  ])

  const handleDriveAuth = useCallback(async () => {
    if (!saveSettings()) {
      return
    }
    setBusyAction('drive')
    setErrorMessage(null)
    try {
      if (loginMode === 'service_account') {
        await authorizeServiceAccount()
      } else {
        await startGoogleDriveOAuth({ prompt: 'select_account' })
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyAction(null)
    }
  }, [authorizeServiceAccount, loginMode, saveSettings, startGoogleDriveOAuth])

  return (
    <div className="flex h-full min-h-0 flex-col bg-nb-surface">
      <header className="border-b border-nb-border px-4 py-3">
        <h2 className="text-base font-semibold text-nb-text">
          Authentication Settings
        </h2>
        <p className="mt-1 text-xs text-nb-text-muted">
          Configure identities, OAuth flows, and clients for Runme and Google
          Drive.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SettingsSection
          title="Runme account"
          description="Choose the effective identity used for Runme Agent requests. A scoped service account is also used for Drive."
        >
          <div className="rounded-nb-sm border border-nb-border bg-white px-3 py-2 text-xs">
            <span className="font-semibold text-nb-text">Current: </span>
            <span className="break-all text-nb-text-muted">
              {runmeAccount ?? 'Not signed in'}
            </span>
          </div>
          <label className={labelClass}>
            Login identity
            <select
              aria-label="Runme login identity"
              className={`${inputClass} mt-1`}
              value={loginMode}
              disabled={busyAction !== null}
              onChange={(event) =>
                setLoginMode(event.target.value as AppLoginMode)
              }
            >
              <option value="principal">Direct human principal</option>
              <option value="service_account">Scoped service account</option>
            </select>
          </label>
          {loginMode === 'service_account' ? (
            <label className={labelClass}>
              Service-account email
              <input
                aria-label="Runme service-account email"
                className={`${inputClass} mt-1`}
                value={serviceAccount}
                disabled={busyAction !== null}
                onChange={(event) => setServiceAccount(event.target.value)}
                placeholder="name@project.iam.gserviceaccount.com"
              />
              <span className={helpClass}>
                The selected human must have Service Account Token Creator on
                this account. Tokens remain memory-only.
              </span>
            </label>
          ) : null}
          <button
            type="button"
            className="rounded-nb-sm bg-nb-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={busyAction !== null || (!authData && !settingsValid)}
            onClick={() => void handleRunmeAuth()}
          >
            {authData
              ? 'Sign out of Runme'
              : busyAction === 'runme'
                ? 'Signing in…'
                : 'Sign in to Runme'}
          </button>
        </SettingsSection>

        <SettingsSection
          title="Google Drive account"
          description="Choose the preferred human account for Drive OAuth and inspect the effective Drive identity."
        >
          <div className="rounded-nb-sm border border-nb-border bg-white px-3 py-2 text-xs">
            <span className="font-semibold text-nb-text">Current: </span>
            <span className="break-all text-nb-text-muted">
              {effectiveDriveAccount ??
                (isDriveSyncing ? 'Connected' : 'Not connected')}
            </span>
          </div>
          <label className={labelClass}>
            Preferred human account
            <input
              aria-label="Preferred Google Drive account"
              className={`${inputClass} mt-1`}
              type="email"
              value={preferredDriveAccount}
              disabled={busyAction !== null || loginMode === 'service_account'}
              onChange={(event) => setPreferredDriveAccount(event.target.value)}
              placeholder="you@example.com"
            />
            <span className={helpClass}>
              Used as Google’s login hint. The account chooser remains
              available. Service-account mode overrides the effective Drive
              identity.
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-nb-sm bg-nb-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={busyAction !== null || !settingsValid}
              onClick={() => void handleDriveAuth()}
            >
              <ArrowPathIcon className="h-4 w-4" />
              {busyAction === 'drive' ? 'Connecting…' : 'Connect or refresh'}
            </button>
            <button
              type="button"
              className="rounded-nb-sm border border-nb-border bg-white px-3 py-2 text-sm font-medium text-nb-text disabled:opacity-50"
              disabled={busyAction !== null || !isDriveSyncing}
              onClick={() => void logoutGoogleDrive()}
            >
              Disconnect
            </button>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Google Drive OAuth flow"
          description="Control how Runme obtains Google Drive credentials. These settings take effect on the next authorization."
        >
          <label className={labelClass}>
            OAuth flow
            <select
              aria-label="Google Drive OAuth flow"
              className={`${inputClass} mt-1`}
              value={driveAuthFlow}
              disabled={busyAction !== null}
              onChange={(event) =>
                setDriveAuthFlow(event.target.value as GoogleDriveAuthFlow)
              }
            >
              <option value="implicit">Implicit</option>
              <option value="pkce">Authorization code with PKCE</option>
              <option value="service_account">
                JSON service-account key (legacy)
              </option>
            </select>
          </label>
          <label className={labelClass}>
            Browser interaction
            <select
              aria-label="Google Drive OAuth interaction"
              className={`${inputClass} mt-1`}
              value={driveAuthUxMode}
              disabled={busyAction !== null}
              onChange={(event) =>
                setDriveAuthUxMode(event.target.value as GoogleDriveAuthUxMode)
              }
            >
              <option value="new_tab">New tab</option>
              <option value="popup">Popup</option>
              <option value="redirect">Same-page redirect</option>
            </select>
          </label>
          {driveAuthFlow === 'service_account' ? (
            <p className="rounded-nb-sm border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
              Legacy JSON-key credentials are configured through App Console.
              Prefer Scoped service account above for keyless, short-lived
              credentials.
            </p>
          ) : null}
        </SettingsSection>

        <SettingsSection
          title="Google Drive OAuth client"
          description="OAuth client registered for this Runme origin and its Google Drive callback URL."
        >
          <label className={labelClass}>
            Client ID
            <input
              aria-label="Google Drive OAuth client ID"
              className={`${inputClass} mt-1 font-mono`}
              value={driveClientId}
              disabled={busyAction !== null}
              onChange={(event) => setDriveClientId(event.target.value)}
            />
          </label>
          <label className={labelClass}>
            Redirect URI
            <input
              aria-label="Google Drive OAuth redirect URI"
              className={`${inputClass} mt-1 font-mono`}
              value={getGoogleDriveOAuthCallbackUrl()}
              readOnly
            />
          </label>
          <label className={labelClass}>
            Client secret (optional)
            <input
              aria-label="Google Drive OAuth client secret"
              className={`${inputClass} mt-1 font-mono`}
              type="password"
              value={driveClientSecret}
              disabled={busyAction !== null}
              onChange={(event) => setDriveClientSecret(event.target.value)}
              autoComplete="off"
            />
          </label>
        </SettingsSection>

        <SettingsSection
          title="Runme OAuth client"
          description="OIDC client used to authenticate Runme Agent requests."
        >
          <label className={labelClass}>
            Discovery URL
            <input
              aria-label="Runme OIDC discovery URL"
              className={`${inputClass} mt-1 font-mono`}
              value={runmeDiscoveryUrl}
              disabled={busyAction !== null}
              onChange={(event) => setRunmeDiscoveryUrl(event.target.value)}
            />
          </label>
          <label className={labelClass}>
            Client ID
            <input
              aria-label="Runme OAuth client ID"
              className={`${inputClass} mt-1 font-mono`}
              value={runmeClientId}
              disabled={busyAction !== null}
              onChange={(event) => setRunmeClientId(event.target.value)}
            />
          </label>
          <label className={labelClass}>
            Redirect URI
            <input
              aria-label="Runme OAuth redirect URI"
              className={`${inputClass} mt-1 font-mono`}
              value={initialOidc.redirectUri}
              readOnly
            />
          </label>
          <label className={labelClass}>
            Client secret (optional)
            <input
              aria-label="Runme OAuth client secret"
              className={`${inputClass} mt-1 font-mono`}
              type="password"
              value={runmeClientSecret}
              disabled={busyAction !== null}
              onChange={(event) => setRunmeClientSecret(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label className={labelClass}>
            Scopes
            <textarea
              aria-label="Runme OAuth scopes"
              className={`${inputClass} mt-1 min-h-16 resize-y font-mono`}
              value={runmeScope}
              disabled={busyAction !== null}
              onChange={(event) => setRunmeScope(event.target.value)}
            />
          </label>
        </SettingsSection>
      </div>

      <footer className="border-t border-nb-border bg-nb-surface px-4 py-3">
        {errorMessage ? (
          <p role="alert" className="mb-2 text-xs leading-5 text-red-700">
            {errorMessage}
          </p>
        ) : null}
        <button
          type="button"
          className="w-full rounded-nb-sm bg-nb-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          disabled={busyAction !== null || !settingsValid}
          onClick={handleSave}
        >
          {busyAction === 'save' ? 'Saving…' : 'Save authentication settings'}
        </button>
      </footer>
    </div>
  )
}
