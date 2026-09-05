import type { Attribution } from './operationLog/reviews'

/** Read the active Drive identity for a human UI submission, never for API labels. */
export async function resolveCommentIdentity(
  getToken?: () => Promise<string>,
  isCurrent: () => boolean = () => true
): Promise<Attribution> {
  const unknown: Attribution = { displayName: 'unknown', kind: 'unknown' }
  try {
    if (!getToken) return unknown
    const token = await getToken()
    const response = await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,permissionId)',
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      }
    )
    if (!response.ok || !isCurrent()) return unknown
    const user = (await response.json()).user
    const name = user?.displayName?.trim() || user?.emailAddress?.trim()
    const principal = user?.permissionId || user?.emailAddress
    if (!name || !principal || !isCurrent()) return unknown
    // Drive reports the effective account, not the human who impersonated it.
    // Never label a Google service account as an authenticated human.
    const serviceAccount = /\.gserviceaccount\.com$/i.test(
      user.emailAddress ?? ''
    )
    return {
      displayName: name,
      kind: serviceAccount ? 'service-account' : 'human',
      source: 'google-drive',
      authenticatedPrincipal: principal,
    }
  } catch {
    return unknown
  }
}
