import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyAppConfig } from './appConfig'
import {
  canLoadContentAsset,
  configureExternalServices,
  getExternalServices,
  localHtmlContent,
} from './externalServices'

afterEach(() => vi.restoreAllMocks())

describe('restricted deployment', () => {
  it('ignores the removed Google sign-in setting in older deployment files', () => {
    applyAppConfig(
      { externalServices: { googleSignIn: false } },
      '/configs/app-configs.yaml'
    )
    expect(getExternalServices()).toEqual({
      analytics: false,
      remoteContent: false,
    })
  })

  it('requires explicit content and analytics opt-ins even when local settings are preferred', () => {
    configureExternalServices({ analytics: true, remoteContent: true })
    applyAppConfig(
      { externalServices: { analytics: 'true', remoteContent: false } },
      '/configs/app-configs.yaml',
      { preserveLocalConfiguration: true }
    )
    expect(getExternalServices()).toEqual({
      analytics: false,
      remoteContent: false,
    })
  })

  it('allows local images but rejects remote and executable URL schemes', () => {
    configureExternalServices({
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
