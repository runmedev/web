import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { jwtDecode } from 'jwt-decode'
import { useCallback, useMemo, useState, type ReactNode } from 'react'

import {
  isGoogleServiceAccountEmail,
  readAppLoginConfiguration,
  saveAppLoginConfiguration,
  type AppLoginMode,
  type IdentitySharingMode,
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

function IdentityFields({
  ariaPrefix,
  busy,
  humanAccount,
  labelPrefix,
  mode,
  onHumanAccountChange,
  onModeChange,
  onServiceAccountChange,
  serviceAccount,
  tourTargets,
}: {
  ariaPrefix: string
  busy: boolean
  humanAccount: string
  labelPrefix?: string
  mode: AppLoginMode
  onHumanAccountChange: (value: string) => void
  onModeChange: (mode: AppLoginMode) => void
  onServiceAccountChange: (value: string) => void
  serviceAccount: string
  tourTargets?: {
    human?: string
    mode?: string
    serviceAccount?: string
  }
}) {
  const prefix = labelPrefix ? `${labelPrefix} ` : ''
  return (
    <>
      <label className={labelClass}>
        {prefix}login identity
        <select
          {...(tourTargets?.mode ? { 'data-tour-id': tourTargets.mode } : {})}
          aria-label={`${ariaPrefix} login identity`}
          className={`${inputClass} mt-1`}
          value={mode}
          disabled={busy}
          onChange={(event) => onModeChange(event.target.value as AppLoginMode)}
        >
          <option value="principal">Direct human principal</option>
          <option value="service_account">
            Impersonated Google service account
          </option>
        </select>
      </label>
      <label className={labelClass}>
        {prefix}human identity
        <input
          {...(tourTargets?.human ? { 'data-tour-id': tourTargets.human } : {})}
          aria-label={`${ariaPrefix} human identity`}
          className={`${inputClass} mt-1`}
          type="email"
          value={humanAccount}
          disabled={busy}
          required={mode === 'service_account'}
          onChange={(event) => onHumanAccountChange(event.target.value)}
          onInput={(event) => onHumanAccountChange(event.currentTarget.value)}
          placeholder="you@example.com"
        />
        <span className={helpClass}>
          Used as Google’s login hint. For impersonation, this human must be
          allowed to use the OAuth client and have Service Account Token Creator
          on the GSA.
        </span>
      </label>
      {mode === 'service_account' ? (
        <label className={labelClass}>
          {prefix}Google service account identity
          <input
            {...(tourTargets?.serviceAccount
              ? { 'data-tour-id': tourTargets.serviceAccount }
              : {})}
            aria-label={`${ariaPrefix} Google service account identity`}
            className={`${inputClass} mt-1`}
            value={serviceAccount}
            disabled={busy}
            onChange={(event) => onServiceAccountChange(event.target.value)}
            placeholder="name@project.iam.gserviceaccount.com"
          />
          <span className={helpClass}>
            The human OAuth token stays in memory. Short-lived service-account
            credentials are stored locally; no JSON key is stored.
          </span>
        </label>
      ) : null}
    </>
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

  const [identitySharing, setIdentitySharing] = useState<IdentitySharingMode>(
    initialLogin.identitySharing
  )
  const [loginMode, setLoginMode] = useState<AppLoginMode>(initialLogin.mode)
  const [humanAccount, setHumanAccount] = useState(
    initialLogin.humanAccount || driveAccount || ''
  )
  const [serviceAccount, setServiceAccount] = useState(
    initialLogin.serviceAccount
  )
  const [driveLoginMode, setDriveLoginMode] = useState<AppLoginMode>(
    initialLogin.driveMode
  )
  const [driveHumanAccount, setDriveHumanAccount] = useState(
    initialLogin.driveHumanAccount || driveAccount || ''
  )
  const [driveServiceAccount, setDriveServiceAccount] = useState(
    initialLogin.driveServiceAccount
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
  const effectiveDriveMode =
    identitySharing === 'shared' ? loginMode : driveLoginMode
  const effectiveDriveHumanAccount =
    identitySharing === 'shared' ? humanAccount : driveHumanAccount
  const effectiveDriveServiceAccount =
    identitySharing === 'shared' ? serviceAccount : driveServiceAccount
  const effectiveDriveAccount =
    effectiveDriveMode === 'service_account' && isDriveSyncing
      ? effectiveDriveServiceAccount
      : driveAccount
  const runmeServiceAccountValid =
    loginMode === 'principal' || isGoogleServiceAccountEmail(serviceAccount)
  const driveServiceAccountValid =
    effectiveDriveMode === 'principal' ||
    isGoogleServiceAccountEmail(effectiveDriveServiceAccount)
  const runmeHumanIdentityValid =
    loginMode === 'principal' || Boolean(humanAccount.trim())
  const driveHumanIdentityValid =
    effectiveDriveMode === 'principal' ||
    Boolean(effectiveDriveHumanAccount.trim())
  const driveClientIdValid = driveClientId
    .trim()
    .endsWith('.apps.googleusercontent.com')
  const requiredFieldsPresent = Boolean(
    driveClientIdValid &&
      runmeDiscoveryUrl.trim() &&
      runmeClientId.trim() &&
      runmeScope.trim()
  )
  const settingsValid =
    runmeServiceAccountValid &&
    driveServiceAccountValid &&
    runmeHumanIdentityValid &&
    driveHumanIdentityValid &&
    requiredFieldsPresent

  const saveSettings = useCallback((): boolean => {
    if (!runmeServiceAccountValid || !driveServiceAccountValid) {
      setErrorMessage('Enter a valid Google service-account identity.')
      return false
    }
    if (!runmeHumanIdentityValid || !driveHumanIdentityValid) {
      setErrorMessage(
        'Enter the human identity that is allowed to impersonate the Google service account.'
      )
      return false
    }
    if (!requiredFieldsPresent) {
      setErrorMessage(
        'Enter a Google Web application client ID ending in .apps.googleusercontent.com and all required Runme OAuth fields.'
      )
      return false
    }
    try {
      saveAppLoginConfiguration({
        identitySharing,
        mode: loginMode,
        humanAccount,
        serviceAccount,
        driveMode: driveLoginMode,
        driveHumanAccount,
        driveServiceAccount,
      })
      setDriveAccount(effectiveDriveHumanAccount)
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
    driveHumanAccount,
    driveLoginMode,
    driveServiceAccount,
    driveServiceAccountValid,
    driveHumanIdentityValid,
    effectiveDriveHumanAccount,
    humanAccount,
    identitySharing,
    loginMode,
    requiredFieldsPresent,
    runmeClientId,
    runmeClientSecret,
    runmeDiscoveryUrl,
    runmeHumanIdentityValid,
    runmeScope,
    serviceAccount,
    runmeServiceAccountValid,
    setDriveAccount,
  ])

  const authorizeServiceAccount = useCallback(
    async (
      selectedServiceAccount: string,
      selectedHumanAccount: string,
      targets: Array<'drive' | 'app'>
    ) => {
      await getServiceAccountCredentials(selectedServiceAccount.trim(), {
        humanAccount: selectedHumanAccount.trim() || undefined,
        prompt: selectedHumanAccount.trim() ? '' : 'select_account',
        targets,
        authorizationLeaseSeconds: 24 * 60 * 60,
      })
    },
    [getServiceAccountCredentials]
  )

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
        await authorizeServiceAccount(
          serviceAccount,
          humanAccount,
          identitySharing === 'shared' ? ['drive', 'app'] : ['app']
        )
      } else {
        await browserAdapter.loginWithRedirect({
          loginHint: humanAccount.trim() || undefined,
        })
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
    humanAccount,
    identitySharing,
    loginMode,
    saveSettings,
    serviceAccount,
  ])

  const handleDriveAuth = useCallback(async () => {
    if (!saveSettings()) {
      return
    }
    setBusyAction('drive')
    setErrorMessage(null)
    try {
      if (effectiveDriveMode === 'service_account') {
        await authorizeServiceAccount(
          effectiveDriveServiceAccount,
          effectiveDriveHumanAccount,
          identitySharing === 'shared' ? ['drive', 'app'] : ['drive']
        )
      } else {
        await startGoogleDriveOAuth({ prompt: 'select_account' })
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyAction(null)
    }
  }, [
    authorizeServiceAccount,
    effectiveDriveHumanAccount,
    effectiveDriveMode,
    effectiveDriveServiceAccount,
    identitySharing,
    saveSettings,
    startGoogleDriveOAuth,
  ])

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
          title="Identity usage"
          description="Decide whether Runme and Google Drive use one effective identity or are configured independently."
        >
          <label className={labelClass}>
            Identity relationship
            <select
              data-tour-id="authentication.identity-sharing"
              aria-label="Runme and Google Drive identity relationship"
              className={`${inputClass} mt-1`}
              value={identitySharing}
              disabled={busyAction !== null}
              onChange={(event) =>
                setIdentitySharing(event.target.value as IdentitySharingMode)
              }
            >
              <option value="shared">
                Use the same identity for Runme and Drive
              </option>
              <option value="separate">
                Configure Runme and Drive separately
              </option>
            </select>
          </label>
        </SettingsSection>

        {identitySharing === 'shared' ? (
          <SettingsSection
            title="Runme and Google Drive identity"
            description="Enter the identity once; both Runme and Drive will use it."
          >
            <div className="rounded-nb-sm border border-nb-border bg-white px-3 py-2 text-xs leading-5">
              <div>
                <span className="font-semibold text-nb-text">Runme: </span>
                <span className="break-all text-nb-text-muted">
                  {runmeAccount ?? 'Not signed in'}
                </span>
              </div>
              <div>
                <span className="font-semibold text-nb-text">Drive: </span>
                <span className="break-all text-nb-text-muted">
                  {effectiveDriveAccount ??
                    (isDriveSyncing ? 'Connected' : 'Not connected')}
                </span>
              </div>
            </div>
            <IdentityFields
              ariaPrefix="Shared"
              busy={busyAction !== null}
              humanAccount={humanAccount}
              mode={loginMode}
              onHumanAccountChange={setHumanAccount}
              onModeChange={setLoginMode}
              onServiceAccountChange={setServiceAccount}
              serviceAccount={serviceAccount}
              tourTargets={{
                mode: 'authentication.runme-login-identity',
                human: 'authentication.authorizing-human-account',
                serviceAccount: 'authentication.service-account-email',
              }}
            />
            <div className="flex flex-wrap gap-2">
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
              <button
                type="button"
                data-tour-id="authentication.google-drive-connect"
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
                Disconnect Drive
              </button>
            </div>
          </SettingsSection>
        ) : (
          <>
            <SettingsSection
              title="Runme identity"
              description="Configure the effective identity used for Runme Agent requests."
            >
              <div className="rounded-nb-sm border border-nb-border bg-white px-3 py-2 text-xs">
                <span className="font-semibold text-nb-text">Current: </span>
                <span className="break-all text-nb-text-muted">
                  {runmeAccount ?? 'Not signed in'}
                </span>
              </div>
              <IdentityFields
                ariaPrefix="Runme"
                busy={busyAction !== null}
                humanAccount={humanAccount}
                labelPrefix="Runme"
                mode={loginMode}
                onHumanAccountChange={setHumanAccount}
                onModeChange={setLoginMode}
                onServiceAccountChange={setServiceAccount}
                serviceAccount={serviceAccount}
              />
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
              title="Google Drive identity"
              description="Configure the effective identity used for Google Drive."
            >
              <div className="rounded-nb-sm border border-nb-border bg-white px-3 py-2 text-xs">
                <span className="font-semibold text-nb-text">Current: </span>
                <span className="break-all text-nb-text-muted">
                  {effectiveDriveAccount ??
                    (isDriveSyncing ? 'Connected' : 'Not connected')}
                </span>
              </div>
              <IdentityFields
                ariaPrefix="Google Drive"
                busy={busyAction !== null}
                humanAccount={driveHumanAccount}
                labelPrefix="Drive"
                mode={driveLoginMode}
                onHumanAccountChange={setDriveHumanAccount}
                onModeChange={setDriveLoginMode}
                onServiceAccountChange={setDriveServiceAccount}
                serviceAccount={driveServiceAccount}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-tour-id="authentication.google-drive-connect"
                  className="inline-flex items-center gap-1.5 rounded-nb-sm bg-nb-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  disabled={busyAction !== null || !settingsValid}
                  onClick={() => void handleDriveAuth()}
                >
                  <ArrowPathIcon className="h-4 w-4" />
                  {busyAction === 'drive'
                    ? 'Connecting…'
                    : 'Connect or refresh'}
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
          </>
        )}

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
          data-tour-id="authentication.save"
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
