/** A compact-preference migration must not leave an immutable old navigation
 * shell serving a launcher that only understands format 1. This runs only on
 * first install or explicit migration after old app tabs save and close, never warm boot.
 */
export async function upgradeLoader(
  serviceWorkers: ServiceWorkerContainer
): Promise<void> {
  const current = serviceWorkers.controller
  if (
    current &&
    (await new Promise<boolean>((resolve) => {
      const channel = new MessageChannel()
      const finish = (supported: boolean) => {
        clearTimeout(timer)
        channel.port1.close()
        resolve(supported)
      }
      const timer = setTimeout(() => finish(false), 500)
      channel.port1.onmessage = ({ data }) =>
        finish(data === 'latest-launcher-v1')
      current.postMessage('runme-loader-bootstrap-policy', [channel.port2])
    }))
  )
    return

  await new Promise<void>((resolve, reject) => {
    let registration: ServiceWorkerRegistration | undefined
    let channel: MessageChannel | undefined
    let acknowledged = false
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      serviceWorkers.removeEventListener('controllerchange', inspect)
      channel?.port1.close()
      if (error) reject(error)
      else resolve()
    }
    const inspect = () => {
      if (settled) return
      if (
        acknowledged &&
        serviceWorkers.controller &&
        serviceWorkers.controller !== current
      ) {
        finish()
        return
      }
      if (!registration?.waiting || channel) return
      channel = new MessageChannel()
      channel.port1.onmessage = ({ data }) => {
        if (data !== 'runme-loader-1') {
          finish(new Error(String(data)))
          return
        }
        acknowledged = true
        inspect()
      }
      // The waiting worker independently probes all windows before skipWaiting.
      registration.waiting.postMessage('runme-loader-upgrade', [channel.port2])
    }
    const poll = setInterval(inspect, 100)
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            'The navigation loader has not updated. Reconnect and retry this upgrade; older release settings have been retained.'
          )
        ),
      15000
    )
    serviceWorkers.addEventListener('controllerchange', inspect)
    void (async () => {
      registration =
        (await serviceWorkers.getRegistration('/')) ??
        (await serviceWorkers.register('/sw.js', { updateViaCache: 'none' }))
      inspect()
      void registration.update().catch(() => {})
    })().catch((error) =>
      finish(error instanceof Error ? error : new Error(String(error)))
    )
  })
}
