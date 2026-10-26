/** Use the worker controlling this document immediately. Registration updates
 * run in the background: a cached app must not wait for a new worker to install.
 * A first visit waits for clients.claim(), with a deadline instead of an
 * unbounded serviceWorker.ready/controllerchange wait. This never forces a
 * waiting worker to activate or bypasses the launcher's compatibility checks.
 */
export function loaderController(
  serviceWorkers: ServiceWorkerContainer,
  timeoutMs = 15000
): Promise<ServiceWorker> {
  const current = serviceWorkers.controller
  if (current) {
    void serviceWorkers
      .getRegistration('/')
      .then((registration) => registration?.update())
      .catch(() => {
        /* The installed worker remains usable offline. */
      })
    return Promise.resolve(current)
  }

  return new Promise<ServiceWorker>((resolve, reject) => {
    let settled = false
    const finish = (worker?: ServiceWorker, error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      serviceWorkers.removeEventListener('controllerchange', onChange)
      if (worker) resolve(worker)
      else reject(error)
    }
    const onChange = () => {
      const worker = serviceWorkers.controller
      if (worker) finish(worker)
    }
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          new Error(
            'The Runme loader is not controlling this tab. Try a normal reload. If it still cannot start, preserve edits in other Runme tabs and close those tabs before reopening Runme. No notebook data has been removed.'
          )
        ),
      timeoutMs
    )
    // Listen before registration, which can claim the page before it resolves.
    serviceWorkers.addEventListener('controllerchange', onChange)
    onChange()
    void (async () => {
      const registration =
        (await serviceWorkers.getRegistration('/')) ??
        (await serviceWorkers.register('/sw.js', { updateViaCache: 'none' }))
      void registration.update().catch(() => {
        /* Offline startup can still use an installed worker. */
      })
      onChange()
    })().catch((error) => finish(undefined, error))
  })
}
