import { APP_ROUTE_PATHS, getAppRouterBasename } from '../lib/appBase'

/** Browser paths include the deployment basename; React Router destinations must not.
 * Restrict stored return locations to this origin and basename before navigation.
 */
export function getOidcReturnRoute(returnTo: string | null): string {
  if (!returnTo?.startsWith('/')) return APP_ROUTE_PATHS.home
  try {
    const url = new URL(returnTo, window.location.origin)
    if (url.origin !== window.location.origin) return APP_ROUTE_PATHS.home
    const basename = getAppRouterBasename()
    let pathname = url.pathname
    if (basename !== '/') {
      if (pathname === basename) pathname = '/'
      else if (pathname.startsWith(basename + '/'))
        pathname = pathname.slice(basename.length)
      else return APP_ROUTE_PATHS.home
    }
    return pathname + url.search + url.hash
  } catch {
    return APP_ROUTE_PATHS.home
  }
}
