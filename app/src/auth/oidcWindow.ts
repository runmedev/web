import type { OidcAuthUxMode } from './oidcConfig'

const MESSAGE_TYPE = 'runme:oidc-callback'
const WINDOW_PREFIX = 'runme-oidc-'
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** Open synchronously during the click, before discovery/PKCE can lose user activation.
 * Only the initiating window handles tokens. The child relays its callback URL;
 * origin + Window identity checks precede the adapter's state/nonce validation.
 */
export function openOidcWindow(
  mode: OidcAuthUxMode,
  redirectUri: string,
  onCallback: (url: URL) => Promise<void>
) {
  if (mode === 'redirect') return null
  const expected = new URL(redirectUri)
  if (expected.origin !== window.location.origin) {
    throw new Error(
      'Popup and new-tab login require a same-origin callback URI.'
    )
  }
  const child = window.open(
    'about:blank',
    WINDOW_PREFIX + crypto.randomUUID(),
    mode === 'popup' ? 'popup=yes,width=600,height=750' : undefined
  )
  if (!child)
    throw new Error(
      'The login window was blocked. Allow popups or select same-page redirect.'
    )
  let settled = false
  let processing = false
  let resolve!: () => void
  let reject!: (error: Error) => void
  const completion = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  // Discovery may fail before the caller starts awaiting completion.
  void completion.catch(() => {})
  const finish = (error?: Error) => {
    if (settled) return
    settled = true
    window.removeEventListener('message', receive)
    clearInterval(closedTimer)
    clearTimeout(timeout)
    child.close()
    if (error) reject(error)
    else resolve()
  }
  const receive = (event: MessageEvent) => {
    if (
      settled ||
      processing ||
      event.origin !== expected.origin ||
      event.source !== child ||
      event.data?.type !== MESSAGE_TYPE ||
      typeof event.data.url !== 'string'
    )
      return
    let url: URL
    try {
      url = new URL(event.data.url)
    } catch {
      return
    }
    if (url.origin !== expected.origin || url.pathname !== expected.pathname)
      return
    processing = true
    void onCallback(url).then(
      () => finish(),
      (error) =>
        finish(error instanceof Error ? error : new Error('Login failed'))
    )
  }
  window.addEventListener('message', receive)
  const closedTimer = setInterval(() => {
    if (child.closed && !processing)
      finish(new Error('Login window was closed before sign-in completed.'))
  }, 500)
  const timeout = setTimeout(
    () => finish(new Error('Login timed out. Please sign in again.')),
    LOGIN_TIMEOUT_MS
  )
  return {
    completion,
    navigate: (url: string) => {
      child.location.href = url
    },
    cancel: () => finish(new Error('Login cancelled.')),
  }
}

/** Callback windows never redeem tokens themselves or open another notebook session. */
export function relayOidcWindowCallback(): boolean {
  if (!window.name.startsWith(WINDOW_PREFIX)) return false
  const url = window.location.href
  window.history.replaceState(null, '', window.location.pathname)
  if (!window.opener)
    throw new Error(
      'The login window lost its connection. Please use same-page redirect.'
    )
  window.opener.postMessage({ type: MESSAGE_TYPE, url }, window.location.origin)
  return true
}
