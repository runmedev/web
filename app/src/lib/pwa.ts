import { appLogger } from './logging/runtime'

const SERVICE_WORKER_PATH = '/sw.js'

type ServiceWorkerRegistrar = {
  register: (scriptURL: string) => Promise<{ scope: string }>
}

type LoadEventTarget = {
  addEventListener: (
    type: 'load',
    listener: () => void,
    options: { once: true }
  ) => void
}

export type RegisterPwaServiceWorkerOptions = {
  enabled?: boolean
  readyState?: DocumentReadyState
  serviceWorker?: ServiceWorkerRegistrar
  target?: LoadEventTarget
}

/**
 * Registers the production service worker after the initial page load. The
 * dependency-injected environment keeps unsupported browsers and unit tests
 * deterministic without changing the production registration path.
 */
export function registerPwaServiceWorker(
  options: RegisterPwaServiceWorkerOptions = {}
): void {
  const enabled = options.enabled ?? import.meta.env.PROD
  const serviceWorker =
    options.serviceWorker ??
    (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined)
  const target =
    options.target ?? (typeof window !== 'undefined' ? window : undefined)
  const readyState =
    options.readyState ??
    (typeof document !== 'undefined' ? document.readyState : 'loading')

  if (!enabled || !serviceWorker || !target) {
    return
  }

  const register = () => {
    void serviceWorker
      .register(SERVICE_WORKER_PATH)
      .then((registration) => {
        appLogger.info('PWA service worker registered', {
          attrs: {
            scope: 'pwa.service-worker',
            serviceWorkerScope: registration.scope,
          },
        })
      })
      .catch((error: unknown) => {
        appLogger.warn('PWA service worker registration failed', {
          attrs: {
            scope: 'pwa.service-worker',
            error: String(error),
          },
        })
      })
  }

  if (readyState === 'complete') {
    register()
    return
  }
  target.addEventListener('load', register, { once: true })
}
