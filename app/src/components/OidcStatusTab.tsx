import { useEffect, useState } from 'react'

import { readAppLoginConfiguration } from '../auth/appLoginConfiguration'
import { oidcDiagnostics } from '../auth/oidcDiagnostics'
import {
  effectiveOidcAuthFlow,
  OIDC_CONFIG_CHANGED_EVENT,
  oidcConfigManager,
} from '../auth/oidcConfig'
import { useBrowserAuthData } from '../browserAdapter.client'

/** Format only bounded, finite dates; malformed saved claims must not crash the tab. */
function timestamp(value?: number) {
  return value === undefined
    ? 'Not available'
    : new Date(value).toLocaleString()
}

const flowName = (flow?: string) =>
  flow === 'pkce'
    ? 'Authorization code with PKCE'
    : flow === 'implicit'
      ? 'Implicit'
      : 'Not recorded'
const interactionName = (mode?: string) =>
  mode === 'redirect'
    ? 'Same-page redirect'
    : mode === 'popup'
      ? 'Popup'
      : mode === 'new_tab'
        ? 'New tab'
        : 'Not recorded'

/** Auth subscriptions refresh claims on login/logout; a timer updates expiry while open.
 * Saved settings describe the NEXT sign-in. Token metadata describes the actual session.
 */
export default function OidcStatusTab() {
  const auth = useBrowserAuthData()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const update = () => setNow(Date.now())
    const timer = setInterval(update, 1000)
    window.addEventListener(OIDC_CONFIG_CHANGED_EVENT, update)
    return () => {
      clearInterval(timer)
      window.removeEventListener(OIDC_CONFIG_CHANGED_EVENT, update)
    }
  }, [])
  const details = oidcDiagnostics(auth, now)
  const config = oidcConfigManager.getConfigForEditing()
  const serviceAccountLogin =
    readAppLoginConfiguration().mode === 'service_account'
  const rows: Array<[string, string]> = [
    ['Status', details.status],
    ['Email', details.email ?? 'Not available'],
    ['Subject', details.subject ?? 'Not available'],
    ['Issuer', details.issuer ?? 'Not available'],
    ['Audience', details.audience ?? 'Not available'],
    ['ID token issued', timestamp(details.issuedAt)],
    ['ID token expires', timestamp(details.idExpiresAt)],
    ['Access token expires', timestamp(details.accessExpiresAt)],
    ['Refresh token', details.hasRefreshToken ? 'Present' : 'Not present'],
    ['Granted scopes', details.grantedScopes ?? 'Not reported by provider'],
    ['Session OAuth flow', flowName(details.loginFlow)],
    ['Session browser interaction', interactionName(details.loginInteraction)],
    [
      'Next sign-in OAuth flow',
      flowName(effectiveOidcAuthFlow(config)) +
        (config.authFlow === 'auto' || !config.authFlow ? ' (automatic)' : ''),
    ],
    [
      'Next sign-in browser interaction',
      interactionName(config.authUxMode ?? 'redirect'),
    ],
    [
      'Configured login identity',
      serviceAccountLogin
        ? 'Impersonated service account (OAuth flow settings apply to direct-principal sign-in)'
        : 'Direct principal',
    ],
    ['Requested scopes', config.scope || 'Not configured'],
    ['Client ID', config.clientId || 'Not configured'],
  ]
  return (
    <section
      id="oidc-status-tab"
      className="h-full overflow-auto p-6 text-nb-text"
      aria-label="Runme authentication information"
    >
      <h1 className="mb-3 text-xl font-semibold">Runme authentication</h1>
      <p className="mb-4 text-sm text-nb-text-muted">
        Current OIDC credentials used for Runme Agent requests. Times are shown
        in your local time zone. Claims are decoded for display; this view does
        not revalidate the token or check runner access.
      </p>
      <dl className="grid grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)] gap-x-4 gap-y-3 text-sm">
        {rows.map(([label, value]) => (
          <div
            key={label}
            data-testid={`oidc-detail-${label}`}
            className="contents"
          >
            <dt className="font-semibold">{label}</dt>
            <dd className="break-words [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {!details.hasRefreshToken && auth && !serviceAccountLogin ? (
        <p className="mt-4 text-sm text-nb-text-muted">
          This session has no refresh token. For OpenAI, request openid email
          offline_access and sign in again using authorization code with PKCE.
          The provider must grant refresh access.
        </p>
      ) : null}
    </section>
  )
}
