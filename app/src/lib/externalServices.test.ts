import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyAppConfig } from './appConfig'
import {
  canLoadContentAsset,
  configureExternalServices,
  getExternalServices,
  localHtmlContent,
  requireGoogleSignIn,
} from './externalServices'

afterEach(() => vi.restoreAllMocks())

describe('restricted deployment', () => {
  it.each([
    {},
    { externalServices: {} },
    { externalServices: { analytics: false } },
  ])('preserves Google sign-in for existing config %j', (config) => {
    applyAppConfig(config, '/configs/app-configs.yaml')
    expect(getExternalServices()).toEqual({
      googleSignIn: true,
      analytics: false,
      remoteContent: false,
    })
    expect(() => requireGoogleSignIn()).not.toThrow()
  })

  it.each([false, 'true'])(
    'honors an explicit disable or invalid value %j even when local settings are preferred',
    (googleSignIn) => {
      configureExternalServices({
        googleSignIn: true,
        analytics: true,
        remoteContent: true,
      })
      applyAppConfig(
        { externalServices: { googleSignIn, analytics: false } },
        '/configs/app-configs.yaml',
        { preserveLocalConfiguration: true }
      )
      expect(getExternalServices()).toEqual({
        googleSignIn: false,
        analytics: false,
        remoteContent: false,
      })
      expect(() => requireGoogleSignIn()).toThrow('disabled by this deployment')
    }
  )
  it('allows local images but rejects remote and executable URL schemes', () => {
    configureExternalServices({
      googleSignIn: false,
      analytics: false,
      remoteContent: false,
    })
    expect(canLoadContentAsset('/assets/image.png')).toBe(true)
    expect(canLoadContentAsset('data:image/png;base64,abc')).toBe(true)
    expect(canLoadContentAsset('https://external.test/image.png')).toBe(false)
    expect(canLoadContentAsset('javascript:alert(1)')).toBe(false)
    expect(localHtmlContent('<img src="https://external.test/a.png">')).toMatch(
      /^<meta http-equiv="Content-Security-Policy"/
    )
    expect(localHtmlContent('content')).toContain("default-src 'none'")
  })
})
