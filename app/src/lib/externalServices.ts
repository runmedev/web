/** Optional content and telemetry choices, not persisted in browser preferences.
 * Authentication remains available and loads its SDK only when needed.
 */
export interface ExternalServices {
  analytics: boolean
  remoteContent: boolean
}
let settings: ExternalServices = {
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
