// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authData: null as { idToken?: string } | null,
  driveAccount: 'drive-user@example.com' as string | null,
  isDriveSyncing: true,
  getServiceAccountCredentials: vi.fn(async () => ({})),
  logoutGoogleDrive: vi.fn(async () => {}),
  setDriveAccount: vi.fn(),
  startGoogleDriveOAuth: vi.fn(async () => ({})),
  loginWithRedirect: vi.fn(async () => {}),
  logout: vi.fn(),
  setOAuthClient: vi.fn(),
  setOidcConfig: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('../../browserAdapter.client', () => ({
  useBrowserAuthData: () => mocks.authData,
  getBrowserAdapter: () => ({
    loginWithRedirect: mocks.loginWithRedirect,
    logout: mocks.logout,
  }),
}))

vi.mock('../../contexts/GoogleAuthContext', () => ({
  useGoogleAuth: () => ({
    driveAccount: mocks.driveAccount,
    getServiceAccountCredentials: mocks.getServiceAccountCredentials,
    isDriveSyncing: mocks.isDriveSyncing,
    logoutGoogleDrive: mocks.logoutGoogleDrive,
    setDriveAccount: mocks.setDriveAccount,
    startGoogleDriveOAuth: mocks.startGoogleDriveOAuth,
  }),
}))

vi.mock('../../lib/googleClientManager', () => ({
  googleClientManager: {
    getOAuthClient: () => ({
      clientId: 'drive-client-id',
      clientSecret: 'drive-client-secret',
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    }),
    setOAuthClient: mocks.setOAuthClient,
  },
}))

vi.mock('../../auth/oidcConfig', () => ({
  oidcConfigManager: {
    getConfigForEditing: () => ({
      discoveryUrl:
        'https://accounts.google.com/.well-known/openid-configuration',
      clientId: 'runme-client-id',
      clientSecret: 'runme-client-secret',
      scope: 'openid email',
      redirectUri: 'http://localhost:5173/oidc/callback',
    }),
    setConfig: mocks.setOidcConfig,
  },
}))

vi.mock('../../lib/toast', () => ({ showToast: mocks.showToast }))

import AuthenticationSettingsPanel from './AuthenticationSettingsPanel'

describe('AuthenticationSettingsPanel', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mocks.authData = null
    mocks.driveAccount = 'drive-user@example.com'
    mocks.isDriveSyncing = true
    mocks.getServiceAccountCredentials.mockClear()
    mocks.logoutGoogleDrive.mockClear()
    mocks.setDriveAccount.mockClear()
    mocks.startGoogleDriveOAuth.mockClear()
    mocks.loginWithRedirect.mockClear()
    mocks.logout.mockClear()
    mocks.setOAuthClient.mockClear()
    mocks.setOidcConfig.mockClear()
    mocks.showToast.mockClear()
  })

  it('groups account, flow, and OAuth client settings in one panel', () => {
    render(<AuthenticationSettingsPanel />)

    expect(
      screen.getByRole('heading', { name: 'Authentication Settings' })
    ).toBeTruthy()
    expect(screen.getByText('Runme account')).toBeTruthy()
    expect(screen.getByText('Google Drive account')).toBeTruthy()
    expect(screen.getByText('Google Drive OAuth flow')).toBeTruthy()
    expect(screen.getByText('Google Drive OAuth client')).toBeTruthy()
    expect(screen.getByText('Runme OAuth client')).toBeTruthy()
    expect(
      screen.getByLabelText('Preferred Google Drive account')
    ).toHaveProperty('value', 'drive-user@example.com')
  })

  it('saves a scoped service-account identity and both OAuth clients', () => {
    render(<AuthenticationSettingsPanel />)

    fireEvent.change(screen.getByLabelText('Runme login identity'), {
      target: { value: 'service_account' },
    })
    fireEvent.change(screen.getByLabelText('Runme service-account email'), {
      target: {
        value: 'runme-web-test@project.iam.gserviceaccount.com',
      },
    })
    fireEvent.change(screen.getByLabelText('Google Drive OAuth flow'), {
      target: { value: 'pkce' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Save authentication settings' })
    )

    expect(
      JSON.parse(
        window.localStorage.getItem('runme/app-login-configuration') ?? '{}'
      )
    ).toEqual({
      mode: 'service_account',
      serviceAccount: 'runme-web-test@project.iam.gserviceaccount.com',
    })
    expect(mocks.setDriveAccount).toHaveBeenCalledWith('drive-user@example.com')
    expect(mocks.setOAuthClient).toHaveBeenCalledWith({
      clientId: 'drive-client-id',
      clientSecret: 'drive-client-secret',
      authFlow: 'pkce',
      authUxMode: 'new_tab',
    })
    expect(mocks.setOidcConfig).toHaveBeenCalledWith({
      discoveryUrl:
        'https://accounts.google.com/.well-known/openid-configuration',
      clientId: 'runme-client-id',
      clientSecret: 'runme-client-secret',
      scope: 'openid email',
    })
  })

  it('uses the saved direct-principal settings to connect Google Drive', async () => {
    render(<AuthenticationSettingsPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect or refresh' }))

    await waitFor(() =>
      expect(mocks.startGoogleDriveOAuth).toHaveBeenCalledWith({
        prompt: 'select_account',
      })
    )
    expect(mocks.getServiceAccountCredentials).not.toHaveBeenCalled()
  })

  it('uses the scoped service account for Runme and Drive authorization', async () => {
    render(<AuthenticationSettingsPanel />)

    fireEvent.change(screen.getByLabelText('Runme login identity'), {
      target: { value: 'service_account' },
    })
    fireEvent.change(screen.getByLabelText('Runme service-account email'), {
      target: { value: 'runme-web-test@project.iam.gserviceaccount.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Runme' }))

    await waitFor(() =>
      expect(mocks.getServiceAccountCredentials).toHaveBeenCalledWith(
        'runme-web-test@project.iam.gserviceaccount.com',
        {
          prompt: 'select_account',
          authorizationLeaseSeconds: 86_400,
          accessTokenLifetimeSeconds: 3_600,
        }
      )
    )
    expect(mocks.loginWithRedirect).not.toHaveBeenCalled()
  })
})
