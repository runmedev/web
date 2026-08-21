// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_APP_LOGIN_CONFIGURATION,
  isGoogleServiceAccountEmail,
  readAppLoginConfiguration,
  saveAppLoginConfiguration,
} from './appLoginConfiguration'

describe('app login configuration', () => {
  beforeEach(() => window.localStorage.clear())

  it('defaults to direct principal login', () => {
    expect(readAppLoginConfiguration()).toEqual(DEFAULT_APP_LOGIN_CONFIGURATION)
  })

  it('persists only the selected mode and normalized service-account email', () => {
    saveAppLoginConfiguration({
      mode: 'service_account',
      serviceAccount: '  runme@example.iam.gserviceaccount.com  ',
    })

    expect(readAppLoginConfiguration()).toEqual({
      mode: 'service_account',
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
    })
  })

  it('validates Google service-account email addresses', () => {
    expect(
      isGoogleServiceAccountEmail('runme@example.iam.gserviceaccount.com')
    ).toBe(true)
    expect(isGoogleServiceAccountEmail('human@example.com')).toBe(false)
  })
})
