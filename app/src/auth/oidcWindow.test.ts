// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openOidcWindow, relayOidcWindowCallback } from './oidcWindow'

describe('OIDC browser interaction', () => {
  let child: Window
  beforeEach(() => {
    vi.useFakeTimers()
    child = {
      closed: false,
      close: vi.fn(),
      location: { href: '' },
    } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(child)
    window.name = ''
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  const redirect = () => window.location.origin + '/oidc/callback'
  function reply(
    source: Window,
    origin = window.location.origin,
    url = redirect() + '?code=fake&state=state'
  ) {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        source,
        data: { type: 'runme:oidc-callback', url },
      })
    )
  }
  it('does not open a window for same-page redirect', () => {
    expect(openOidcWindow('redirect', redirect(), vi.fn())).toBeNull()
    expect(window.open).not.toHaveBeenCalled()
  })
  it.each(['popup', 'new_tab'] as const)(
    'opens %s before asynchronous work and accepts only its same-origin callback',
    async (mode) => {
      const consume = vi.fn(async () => {})
      const login = openOidcWindow(mode, redirect(), consume)!
      expect(window.open).toHaveBeenCalledOnce()
      login.navigate('https://issuer.example/authorize')
      expect(child.location.href).toBe('https://issuer.example/authorize')
      reply(child, 'https://evil.example')
      reply(window)
      reply(child, window.location.origin, window.location.origin + '/other')
      expect(consume).not.toHaveBeenCalled()
      reply(child)
      reply(child)
      await login.completion
      expect(consume).toHaveBeenCalledOnce()
      expect(child.close).toHaveBeenCalledOnce()
      reply(child)
      expect(consume).toHaveBeenCalledOnce()
    }
  )
  it('surfaces blocked windows without starting login', () => {
    vi.mocked(window.open).mockReturnValue(null)
    expect(() => openOidcWindow('popup', redirect(), vi.fn())).toThrow(
      'blocked'
    )
  })
  it('surfaces denial and closes the callback window', async () => {
    const login = openOidcWindow('popup', redirect(), async () => {
      throw new Error('denied')
    })!
    const result = expect(login.completion).rejects.toThrow('denied')
    reply(child)
    await result
    expect(child.close).toHaveBeenCalledOnce()
  })
  it('cancels when the user closes the window', async () => {
    const login = openOidcWindow('popup', redirect(), vi.fn())!
    Object.assign(child, { closed: true })
    const result = expect(login.completion).rejects.toThrow('closed')
    await vi.advanceTimersByTimeAsync(500)
    await result
  })
  it('times out and removes the callback listener', async () => {
    const consume = vi.fn()
    const login = openOidcWindow('new_tab', redirect(), consume)!
    const result = expect(login.completion).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(600_000)
    await result
    reply(child)
    expect(consume).not.toHaveBeenCalled()
  })
  it('never sends callback material to an unrelated opener', () => {
    const postMessage = vi.fn()
    vi.stubGlobal('opener', { postMessage })
    expect(relayOidcWindowCallback()).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
