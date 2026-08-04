import { describe, expect, it, vi } from 'vitest'

import { registerPwaServiceWorker } from './pwa'

describe('registerPwaServiceWorker', () => {
  it('does nothing outside production mode', () => {
    const register = vi.fn()
    const addEventListener = vi.fn()

    registerPwaServiceWorker({
      enabled: false,
      serviceWorker: { register },
      target: { addEventListener },
    })

    expect(register).not.toHaveBeenCalled()
    expect(addEventListener).not.toHaveBeenCalled()
  })

  it('registers once the initial page load completes', async () => {
    const register = vi.fn().mockResolvedValue({ scope: '/' })
    const addEventListener = vi.fn()

    registerPwaServiceWorker({
      enabled: true,
      readyState: 'loading',
      serviceWorker: { register },
      target: { addEventListener },
    })

    expect(addEventListener).toHaveBeenCalledWith(
      'load',
      expect.any(Function),
      { once: true }
    )
    const onLoad = addEventListener.mock.calls[0][1] as () => void
    onLoad()
    await Promise.resolve()

    expect(register).toHaveBeenCalledWith('/sw.js')
  })

  it('registers immediately when the document is already loaded', async () => {
    const register = vi.fn().mockResolvedValue({ scope: '/' })
    const addEventListener = vi.fn()

    registerPwaServiceWorker({
      enabled: true,
      readyState: 'complete',
      serviceWorker: { register },
      target: { addEventListener },
    })
    await Promise.resolve()

    expect(register).toHaveBeenCalledWith('/sw.js')
    expect(addEventListener).not.toHaveBeenCalled()
  })
})
