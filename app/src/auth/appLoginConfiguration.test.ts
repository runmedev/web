// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  APP_LOGIN_CONFIGURATION_CHANGED_EVENT,
  DEFAULT_APP_LOGIN_CONFIGURATION,
  isGoogleServiceAccountEmail,
  readAppLoginConfiguration,
  resolveDriveLoginConfiguration,
  saveAppLoginConfiguration,
} from './appLoginConfiguration'

describe('app login configuration', () => {
  beforeEach(() => window.localStorage.clear())

  it('defaults to direct principal login', () => {
    expect(readAppLoginConfiguration()).toEqual(DEFAULT_APP_LOGIN_CONFIGURATION)
  })

  it('persists shared and separate identities with normalized emails', () => {
    const configurationChanged = vi.fn()
    window.addEventListener(
      APP_LOGIN_CONFIGURATION_CHANGED_EVENT,
      configurationChanged
    )
    saveAppLoginConfiguration({
      identitySharing: 'separate',
      mode: 'service_account',
      humanAccount: '  runme-human@example.com  ',
      serviceAccount: '  runme@example.iam.gserviceaccount.com  ',
      driveMode: 'service_account',
      driveHumanAccount: '  drive-human@example.com  ',
      driveServiceAccount: '  drive@example.iam.gserviceaccount.com  ',
    })

    expect(readAppLoginConfiguration()).toEqual({
      identitySharing: 'separate',
      mode: 'service_account',
      humanAccount: 'runme-human@example.com',
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
      driveMode: 'service_account',
      driveHumanAccount: 'drive-human@example.com',
      driveServiceAccount: 'drive@example.iam.gserviceaccount.com',
    })
    expect(configurationChanged).toHaveBeenCalledOnce()
    window.removeEventListener(
      APP_LOGIN_CONFIGURATION_CHANGED_EVENT,
      configurationChanged
    )
  })

  it('resolves the effective Drive identity configuration', () => {
    expect(
      resolveDriveLoginConfiguration({
        identitySharing: 'shared',
        mode: 'service_account',
        humanAccount: 'human@example.com',
        serviceAccount: 'shared@example.iam.gserviceaccount.com',
        driveMode: 'principal',
        driveHumanAccount: 'drive@example.com',
        driveServiceAccount: '',
      })
    ).toEqual({
      mode: 'service_account',
      humanAccount: 'human@example.com',
      serviceAccount: 'shared@example.iam.gserviceaccount.com',
    })
  })

  it('migrates the previous single-identity configuration as shared', () => {
    window.localStorage.setItem(
      'runme/app-login-configuration',
      JSON.stringify({
        mode: 'service_account',
        serviceAccount: 'runme@example.iam.gserviceaccount.com',
      })
    )

    expect(readAppLoginConfiguration()).toMatchObject({
      identitySharing: 'shared',
      mode: 'service_account',
      serviceAccount: 'runme@example.iam.gserviceaccount.com',
    })
  })

  it('validates Google service-account email addresses', () => {
    expect(
      isGoogleServiceAccountEmail('runme@example.iam.gserviceaccount.com')
    ).toBe(true)
    expect(isGoogleServiceAccountEmail('human@example.com')).toBe(false)
    expect(
      isGoogleServiceAccountEmail(
        'jlewi-runme@runme-lewi.dev.iam.gserviceaccount.com'
      )
    ).toBe(false)
    expect(
      isGoogleServiceAccountEmail(
        'jlewi-runme@runme-lewi-dev.iam.gserviceaccount.com'
      )
    ).toBe(true)
  })
})
