/** Deployment choices, deliberately not persisted in browser preferences.
 * Google sign-in stays available on existing deployments. Restricted deployments
 * explicitly disable it before authentication initializes; the SDK loads lazily.
 */
export interface ExternalServices {
  googleSignIn: boolean
  analytics: boolean
  remoteContent: boolean
}
let settings: ExternalServices = {
  googleSignIn: true,
  analytics: false,
  remoteContent: false,
}

/** Apply the server's choices before initializing optional services. */
export function configureExternalServices(value: ExternalServices): void {
  settings = { ...value }
}
/** Read deployment choices without consulting local preferences. */
export function getExternalServices(): Readonly<ExternalServices> {
  return settings
}

/** Fail locally rather than opening a Google popup or loading a remote SDK. */
export function requireGoogleSignIn(): void {
  if (!settings.googleSignIn)
    throw new Error(
      'Google sign-in is disabled by this deployment. Configure a credential provider for unattended Drive access.'
    )
}

/** Notebook-provided assets remain optional; local/blob/data assets work offline. */
export function canLoadContentAsset(src: string | undefined): boolean {
  if (!src) return false
  if (settings.remoteContent) return true
  try {
    const url = new URL(src, window.location.href)
    return (
      ['data:', 'blob:'].includes(url.protocol) ||
      url.origin === window.location.origin
    )
  } catch {
    return false
  }
}

/** Apply the same asset boundary inside opaque-origin notebook HTML frames. */
export function localHtmlContent(html: string): string {
  if (settings.remoteContent) return html
  const origin = window.location.origin
  return (
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${origin} blob:; style-src 'unsafe-inline' ${origin}; img-src ${origin} data: blob:; font-src ${origin} data:; media-src ${origin} data: blob:; connect-src ${origin}; frame-src ${origin}; base-uri 'none'; form-action 'none'">` +
    html
  )
}
