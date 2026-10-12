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
  it('requires explicit boolean opt-ins, even when local settings are preferred', () => {
    configureExternalServices({
      googleSignIn: true,
      analytics: true,
      remoteContent: true,
    })
    applyAppConfig(
      { externalServices: { googleSignIn: 'true', analytics: false } },
      '/configs/app-configs.yaml',
      { preserveLocalConfiguration: true }
    )
    expect(getExternalServices()).toEqual({
      googleSignIn: false,
      analytics: false,
      remoteContent: false,
    })
    expect(() => requireGoogleSignIn()).toThrow('disabled by this deployment')
  })
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
