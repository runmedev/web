import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { relayOidcWindowCallback } from '../auth/oidcWindow'
import { getBrowserAdapter } from '../browserAdapter.client'
import { APP_ROUTE_PATHS } from '../lib/appBase'
import { appLogger } from '../lib/logging/runtime'

/**
 * Apps running in-browser auth still need to implement a handler at a callback URL. The
 * `redirectUri` that you pass to the OaiAuthBrowserAdapter should point to a page that
 * can run this logic.
 */
export default function Callback() {
  const navigate = useNavigate()
  const [message, setMessage] = useState('Completing sign-in…')

  useEffect(() => {
    try {
      if (relayOidcWindowCallback()) {
        setMessage('Completing sign-in in the original Runme tab.')
        return
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Login failed')
      return
    }
    const controller = new AbortController()
    const browserAdapter = getBrowserAdapter()
    appLogger.info('OIDC callback route mounted', {
      attrs: {
        scope: 'auth.oidc',
        code: 'OIDC_CALLBACK_ROUTE_MOUNTED',
        pathname: window.location.pathname,
      },
    })
    Promise.all([browserAdapter.handleCallback()])
      .then(() => {
        if (controller.signal.aborted) return
        appLogger.info('OIDC callback handling completed', {
          attrs: {
            scope: 'auth.oidc',
            code: 'OIDC_CALLBACK_ROUTE_SUCCESS',
            pathname: window.location.pathname,
          },
        })

        // Navigate back to the main page after handling the callback
        const returnTo = window.sessionStorage.getItem('oidc_login_return')
        window.sessionStorage.removeItem('oidc_login_return')
        navigate(
          returnTo?.startsWith('/') && !returnTo.startsWith('//')
            ? returnTo
            : APP_ROUTE_PATHS.home,
          { replace: true }
        )
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        appLogger.error('OIDC callback handling failed', {
          attrs: {
            scope: 'auth.oidc',
            code: 'OIDC_CALLBACK_ROUTE_FAILED',
            pathname: window.location.pathname,
            error: String(error),
          },
        })
        navigate(APP_ROUTE_PATHS.home, { replace: true })
      })

    // If the user navigates away on their own, cancel the post-callback navigation above
    return () => controller.abort()
  }, [])

  return (
    <p role="status" className="p-4">
      {message}
    </p>
  )
}
