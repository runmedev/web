import { afterEach, expect, it, vi } from 'vitest'

const selection = vi.hoisted(() => ({ select: vi.fn() }))
vi.mock('./launcherSelection', () => ({
  launcherDescriptor: (value: unknown) => value,
  selectLauncher: selection.select,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

it('answers compatibility probes throughout discovery, then hands off to the launcher', async () => {
  vi.useFakeTimers()
  const serviceWorker = new EventTarget()
  vi.stubGlobal('navigator', { serviceWorker })
  const descriptor = { releaseId: 'test-release', entry: 'launcher.js' }
  document.body.innerHTML = `<script id="runme-launcher-fallback" type="application/json">${JSON.stringify(descriptor)}</script>`
  let complete!: (value: unknown) => void
  selection.select.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve
    })
  )
  await import('./bootstrap')

  const postMessage = vi.fn()
  const probe = () =>
    serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: 'runme-loader-probe',
        ports: [{ postMessage } as unknown as MessagePort],
      })
    )
  // Reproduce discovery taking longer than the service worker's two-second
  // peer deadline without granting storage ownership or importing an app.
  await vi.advanceTimersByTimeAsync(2500)
  probe()
  expect(postMessage).toHaveBeenCalledTimes(1)
  expect(postMessage).toHaveBeenCalledWith('runme-loader-1')
  expect(document.querySelector('script[type="module"]')).toBeNull()

  complete({ descriptor, source: 'latest' })
  await vi.advanceTimersByTimeAsync(0)
  const script = document.querySelector<HTMLScriptElement>(
    'script[type="module"]'
  )!
  expect(script).not.toBeNull()
  script.dispatchEvent(new Event('load'))
  probe()
  expect(postMessage).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
