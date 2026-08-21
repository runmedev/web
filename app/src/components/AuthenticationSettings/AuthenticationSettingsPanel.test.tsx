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
      clientId: 'drive-client-id.apps.googleusercontent.com',
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
    expect(screen.getByText('Identity usage')).toBeTruthy()
    expect(screen.getByText('Runme and Google Drive identity')).toBeTruthy()
    expect(screen.getByText('Google Drive OAuth flow')).toBeTruthy()
    expect(screen.getByText('Google Drive OAuth client')).toBeTruthy()
    expect(screen.getByText('Runme OAuth client')).toBeTruthy()
    expect(screen.getByLabelText('Shared human identity')).toHaveProperty(
      'value',
      'drive-user@example.com'
    )
  })

  it('registers the authentication controls as AI tour targets', () => {
    render(<AuthenticationSettingsPanel />)

    const relationship = screen.getByLabelText(
      'Runme and Google Drive identity relationship'
    )
    expect(relationship.getAttribute('data-tour-id')).toBe(
      'authentication.identity-sharing'
    )
    const loginIdentity = screen.getByLabelText('Shared login identity')
    expect(loginIdentity.getAttribute('data-tour-id')).toBe(
      'authentication.runme-login-identity'
    )
    expect(
      screen
        .getByLabelText('Shared human identity')
        .getAttribute('data-tour-id')
    ).toBe('authentication.authorizing-human-account')
    expect(
      screen
        .getByRole('button', { name: 'Connect or refresh' })
        .getAttribute('data-tour-id')
    ).toBe('authentication.google-drive-connect')
    expect(
      screen
        .getByRole('button', { name: 'Save authentication settings' })
        .getAttribute('data-tour-id')
    ).toBe('authentication.save')

    fireEvent.change(loginIdentity, {
      target: { value: 'service_account' },
    })
    expect(
      screen
        .getByLabelText('Shared Google service account identity')
        .getAttribute('data-tour-id')
    ).toBe('authentication.service-account-email')
  })

  it('saves a scoped service-account identity and both OAuth clients', () => {
    render(<AuthenticationSettingsPanel />)

    fireEvent.change(screen.getByLabelText('Shared login identity'), {
      target: { value: 'service_account' },
    })
    fireEvent.change(
      screen.getByLabelText('Shared Google service account identity'),
      {
        target: {
          value: 'runme-web-test@project.iam.gserviceaccount.com',
        },
      }
    )
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
      identitySharing: 'shared',
      mode: 'service_account',
      humanAccount: 'drive-user@example.com',
      serviceAccount: 'runme-web-test@project.iam.gserviceaccount.com',
      driveMode: 'principal',
      driveHumanAccount: 'drive-user@example.com',
      driveServiceAccount: '',
    })
    expect(mocks.setDriveAccount).toHaveBeenCalledWith('drive-user@example.com')
    expect(mocks.setOAuthClient).toHaveBeenCalledWith({
      clientId: 'drive-client-id.apps.googleusercontent.com',
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

  it('uses the shared human identity as the Runme OIDC login hint', async () => {
    render(<AuthenticationSettingsPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Runme' }))

    await waitFor(() =>
      expect(mocks.loginWithRedirect).toHaveBeenCalledWith({
        loginHint: 'drive-user@example.com',
      })
    )
  })

  it('uses the scoped service account for Runme and Drive authorization', async () => {
    render(<AuthenticationSettingsPanel />)

    fireEvent.change(screen.getByLabelText('Shared login identity'), {
      target: { value: 'service_account' },
    })
    fireEvent.change(
      screen.getByLabelText('Shared Google service account identity'),
      {
        target: { value: 'runme-web-test@project.iam.gserviceaccount.com' },
      }
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Runme' }))

    await waitFor(() =>
      expect(mocks.getServiceAccountCredentials).toHaveBeenCalledWith(
        'runme-web-test@project.iam.gserviceaccount.com',
        {
          humanAccount: 'drive-user@example.com',
          prompt: '',
          targets: ['drive', 'app'],
          authorizationLeaseSeconds: 86_400,
          accessTokenLifetimeSeconds: 3_600,
        }
      )
    )
    expect(mocks.loginWithRedirect).not.toHaveBeenCalled()
  })

  it('requires a human identity before service-account impersonation', () => {
    render(<AuthenticationSettingsPanel />)

    fireEvent.change(screen.getByLabelText('Shared login identity'), {
      target: { value: 'service_account' },
    })
    fireEvent.input(screen.getByLabelText('Shared human identity'), {
      target: { value: '' },
    })
    fireEvent.change(
      screen.getByLabelText('Shared Google service account identity'),
      {
        target: { value: 'runme-web-test@project.iam.gserviceaccount.com' },
      }
    )

    expect(screen.getByLabelText('Shared human identity')).toHaveProperty(
      'required',
      true
    )
    expect(
      screen.getByRole('button', { name: 'Connect or refresh' })
    ).toHaveProperty('disabled', true)
    expect(mocks.getServiceAccountCredentials).not.toHaveBeenCalled()
  })

  it('rejects a numeric service-account client ID as the Drive OAuth client', () => {
    render(<AuthenticationSettingsPanel />)

    fireEvent.change(screen.getByLabelText('Google Drive OAuth client ID'), {
      target: { value: '105590327376962406009' },
    })

    expect(
      screen.getByRole('button', { name: 'Save authentication settings' })
    ).toHaveProperty('disabled', true)
  })

  it('keeps Runme and Drive service-account targets separate when requested', async () => {
    render(<AuthenticationSettingsPanel />)

    fireEvent.change(
      screen.getByLabelText('Runme and Google Drive identity relationship'),
      { target: { value: 'separate' } }
    )
    fireEvent.change(screen.getByLabelText('Runme login identity'), {
      target: { value: 'service_account' },
    })
    fireEvent.change(
      screen.getByLabelText('Runme Google service account identity'),
      { target: { value: 'runme@project.iam.gserviceaccount.com' } }
    )
    fireEvent.change(screen.getByLabelText('Google Drive login identity'), {
      target: { value: 'service_account' },
    })
    fireEvent.change(
      screen.getByLabelText('Google Drive Google service account identity'),
      { target: { value: 'drive@project.iam.gserviceaccount.com' } }
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Runme' }))
    await waitFor(() =>
      expect(mocks.getServiceAccountCredentials).toHaveBeenLastCalledWith(
        'runme@project.iam.gserviceaccount.com',
        expect.objectContaining({ targets: ['app'] })
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Connect or refresh' }))
    await waitFor(() =>
      expect(mocks.getServiceAccountCredentials).toHaveBeenLastCalledWith(
        'drive@project.iam.gserviceaccount.com',
        expect.objectContaining({ targets: ['drive'] })
      )
    )
  })
})
