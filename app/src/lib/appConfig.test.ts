import { beforeEach, describe, expect, it, vi } from 'vitest'

import localAppConfigYaml from '../../assets/configs/app-configs.yaml?raw'

async function loadModules() {
  vi.resetModules()
  const appConfig = await import('./appConfig')
  const oidcConfig = await import('../auth/oidcConfig')
  return {
    ...appConfig,
    ...oidcConfig,
  }
}

describe('appConfig OIDC Google shorthand', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState(null, '', '/index.html')
  })

  it('applies Google defaults when oidc.google is configured', async () => {
    const { applyAppConfig } = await loadModules()

    const result = applyAppConfig(
      {
        agent: {
          endpoint: 'http://localhost:9977',
        },
        oidc: {
          google: {
            clientID: 'client-id.apps.googleusercontent.com',
          },
        },
      },
      'http://localhost/configs/app-configs.yaml'
    )

    expect(result.warnings).toEqual([])
    expect(result.oidc).toMatchObject({
      discoveryUrl:
        'https://accounts.google.com/.well-known/openid-configuration',
      clientId: 'client-id.apps.googleusercontent.com',
      scope: 'openid https://www.googleapis.com/auth/userinfo.email',
      extraAuthParams: {
        access_type: 'offline',
        prompt: 'consent',
      },
    })
    expect(result.oidc?.redirectUri).toMatch(
      /^http:\/\/localhost(:\d+)?\/oidc\/callback$/
    )
  })

  it('allows setGoogleDefaults before the client ID is set', async () => {
    const { oidcConfigManager } = await loadModules()

    expect(() => oidcConfigManager.setGoogleDefaults()).not.toThrow()

    const config = oidcConfigManager.setClientId(
      'client-id.apps.googleusercontent.com'
    )

    expect(config.discoveryUrl).toBe(
      'https://accounts.google.com/.well-known/openid-configuration'
    )
    expect(config.scope).toBe(
      'openid https://www.googleapis.com/auth/userinfo.email'
    )
    expect(config.clientId).toBe('client-id.apps.googleusercontent.com')
    expect(config.extraAuthParams).toEqual({
      access_type: 'offline',
      prompt: 'consent',
    })
  })

  it('preserves the runtime Google Drive base URL when config omits it', async () => {
    const { applyAppConfig } = await loadModules()
    const { setGoogleDriveBaseUrl, getGoogleDriveBaseUrl } = await import(
      './googleDriveRuntime'
    )

    setGoogleDriveBaseUrl('http://127.0.0.1:9090')

    applyAppConfig(
      {
        agent: {
          endpoint: 'http://localhost:9977',
        },
        googleDrive: {
          clientID: 'client-id.apps.googleusercontent.com',
        },
      },
      'http://localhost/configs/app-configs.yaml'
    )

    expect(getGoogleDriveBaseUrl()).toBe('http://127.0.0.1:9090')
  })

  it('configures local development with secret-free implicit Drive auth', async () => {
    const { setAppConfigFromYaml } = await loadModules()
    const { getGoogleDriveBaseUrl } = await import('./googleDriveRuntime')

    const result = setAppConfigFromYaml(
      localAppConfigYaml,
      'http://localhost/configs/app-configs.yaml'
    )

    expect(result.warnings).toEqual([])
    expect(result.oidc?.clientId).toBeTruthy()
    // Keep an accidentally reintroduced credential out of test failure output.
    expect(Boolean(result.oidc?.clientSecret)).toBe(false)
    expect(result.googleOAuth?.clientId).toBeTruthy()
    expect(Boolean(result.googleOAuth?.clientSecret)).toBe(false)
    expect(result.googleOAuth?.authFlow).toBe('implicit')
    expect(getGoogleDriveBaseUrl()).toBe('https://www.googleapis.com')
  })

  it('applies Google Drive PKCE auth flow when configured', async () => {
    const { applyAppConfig } = await loadModules()
    const { googleClientManager } = await import('./googleClientManager')

    applyAppConfig(
      {
        agent: {
          endpoint: 'http://localhost:9977',
        },
        googleDrive: {
          clientID: 'client-id.apps.googleusercontent.com',
          authFlow: 'pkce',
        },
      },
      'http://localhost/configs/app-configs.yaml'
    )

    expect(googleClientManager.getOAuthClient()).toMatchObject({
      clientId: 'client-id.apps.googleusercontent.com',
      authFlow: 'pkce',
      authUxMode: 'new_tab',
    })
    expect(googleClientManager.getDrivePickerConfig().clientId).toBe(
      'client-id.apps.googleusercontent.com'
    )
  })

  it('applies Google Drive implicit redirect auth mode when configured', async () => {
    const { applyAppConfig } = await loadModules()
    const { googleClientManager } = await import('./googleClientManager')

    applyAppConfig(
      {
        agent: {
          endpoint: 'http://localhost:9977',
        },
        googleDrive: {
          clientID: 'client-id.apps.googleusercontent.com',
          authFlow: 'implicit',
          authUxMode: 'redirect',
        },
      },
      'http://localhost/configs/app-configs.yaml'
    )

    expect(googleClientManager.getOAuthClient()).toMatchObject({
      clientId: 'client-id.apps.googleusercontent.com',
      authFlow: 'implicit',
      authUxMode: 'redirect',
    })
  })

  it.each([true, false])(
    'migrates the old development OIDC secret with local precedence %s',
    async (preserveLocalConfiguration) => {
      window.localStorage.setItem(
        'oidcConfig',
        JSON.stringify({
          clientId:
            '554943104515-bdt3on71kvc489nvi3l37gialolcnk0a.apps.googleusercontent.com',
          discoveryUrl:
            'https://accounts.google.com/.well-known/openid-configuration',
          clientSecret: 'previously-shipped-secret-fixture',
          scope: 'openid email',
          redirectUri: `${window.location.origin}/callback`,
        })
      )
      window.localStorage.setItem(
        'oidc-auth',
        JSON.stringify({
          access_token: 'old-access-token',
          refresh_token: 'old-refresh-token',
        })
      )
      const { setAppConfigFromYaml, getOidcConfig } = await loadModules()
      setAppConfigFromYaml(
        localAppConfigYaml,
        'http://localhost/configs/app-configs.yaml',
        {
          preserveLocalConfiguration,
        }
      )
      const { usesGoogleImplicitLogin } = await import(
        '../auth/googleImplicitLogin'
      )
      expect(usesGoogleImplicitLogin(getOidcConfig())).toBe(true)
      expect(Boolean(getOidcConfig().clientSecret)).toBe(false)
      expect(
        Boolean(
          JSON.parse(window.localStorage.getItem('oidcConfig')!).clientSecret
        )
      ).toBe(false)
      expect(window.localStorage.getItem('oidc-auth')).toBeNull()
    }
  )

  it.each([
    [
      'custom-client',
      'https://accounts.google.com/.well-known/openid-configuration',
    ],
    [
      '554943104515-bdt3on71kvc489nvi3l37gialolcnk0a.apps.googleusercontent.com',
      'https://issuer.example/discovery',
    ],
  ])(
    'preserves privately configured credentials for %s at %s',
    async (clientId, discoveryUrl) => {
      window.localStorage.setItem(
        'oidcConfig',
        JSON.stringify({
          clientId,
          discoveryUrl,
          clientSecret: 'custom-secret-fixture',
          scope: 'openid email',
        })
      )
      const { getOidcConfig } = await loadModules()
      expect(getOidcConfig().clientSecret).toBe('custom-secret-fixture')
    }
  )

  it('defaults Google Drive auth UX mode to new_tab when not configured', async () => {
    const { applyAppConfig } = await loadModules()
    const { googleClientManager } = await import('./googleClientManager')

    applyAppConfig(
      {
        agent: {
          endpoint: 'http://localhost:9977',
        },
        googleDrive: {
          clientID: 'client-id.apps.googleusercontent.com',
          authFlow: 'implicit',
        },
      },
      'http://localhost/configs/app-configs.yaml'
    )

    expect(googleClientManager.getOAuthClient()).toMatchObject({
      clientId: 'client-id.apps.googleusercontent.com',
      authFlow: 'implicit',
      authUxMode: 'new_tab',
    })
  })

  it('preserves local Google Drive config when local precedence is requested', async () => {
    const { applyAppConfig } = await loadModules()
    const { googleClientManager } = await import('./googleClientManager')

    googleClientManager.setOAuthClient({
      clientId: 'local-client.apps.googleusercontent.com',
      authFlow: 'pkce',
      authUxMode: 'redirect',
    })

    applyAppConfig(
      {
        agent: {
          endpoint: 'http://localhost:9977',
        },
        googleDrive: {
          clientID: 'config-client.apps.googleusercontent.com',
          authFlow: 'implicit',
        },
      },
      'http://localhost/configs/app-configs.yaml',
      {
        preserveLocalConfiguration: true,
      }
    )

    expect(googleClientManager.getOAuthClient()).toMatchObject({
      clientId: 'local-client.apps.googleusercontent.com',
      authFlow: 'pkce',
      authUxMode: 'redirect',
    })
  })

  it('uses joined googleDrive clientMaterial as clientSecret when provided', async () => {
    const { applyAppConfig } = await loadModules()
    const { googleClientManager } = await import('./googleClientManager')

    applyAppConfig(
      {
        agent: {
          endpoint: 'http://localhost:9977',
        },
        googleDrive: {
          clientID: 'client-id.apps.googleusercontent.com',
          clientSecret: 'ignored-client-secret',
          clientMaterial: ['test-', 'client-', 'secret'],
        },
      },
      'http://localhost/configs/app-configs.yaml'
    )

    expect(googleClientManager.getOAuthClient()).toMatchObject({
      clientId: 'client-id.apps.googleusercontent.com',
      clientSecret: 'test-client-secret',
    })
  })

  it('applies Google Drive service account auth without an OAuth client ID', async () => {
    const { applyAppConfig } = await loadModules()
    const { googleClientManager } = await import('./googleClientManager')

    const result = applyAppConfig(
      {
        agent: {
          endpoint: 'http://localhost:9977',
        },
        googleDrive: {
          authFlow: 'service_account',
          serviceAccount: {
            client_email: 'runme-drive-test@example.iam.gserviceaccount.com',
            private_key:
              '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
            private_key_id: 'key-id',
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
          },
        },
      },
      'http://localhost/configs/app-configs.yaml'
    )

    expect(result.warnings).toEqual([])
    expect(googleClientManager.getOAuthClient()).toMatchObject({
      clientId: '',
      authFlow: 'service_account',
      authUxMode: 'new_tab',
      serviceAccount: {
        clientEmail: 'runme-drive-test@example.iam.gserviceaccount.com',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n',
        privateKeyId: 'key-id',
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      },
    })
  })

  it('toggles app-config local precedence on load', async () => {
    const {
      disableAppConfigOverridesOnLoad,
      enableAppConfigOverridesOnLoad,
      isLocalConfigPreferredOnLoad,
      setLocalConfigPreferredOnLoad,
    } = await loadModules()

    expect(isLocalConfigPreferredOnLoad()).toBe(true)

    expect(setLocalConfigPreferredOnLoad(false)).toBe(false)
    expect(isLocalConfigPreferredOnLoad()).toBe(false)

    expect(disableAppConfigOverridesOnLoad()).toBe(true)
    expect(isLocalConfigPreferredOnLoad()).toBe(true)

    expect(enableAppConfigOverridesOnLoad()).toBe(false)
    expect(isLocalConfigPreferredOnLoad()).toBe(false)
  })

  it('applies inline YAML via setAppConfigFromYaml', async () => {
    const { setAppConfigFromYaml } = await loadModules()

    const result = setAppConfigFromYaml(
      ['agent:', '  endpoint: http://localhost:9977'].join('\n'),
      'inline://test-config.yaml'
    )

    expect(result.url).toBe('inline://test-config.yaml')
    expect(result.agentEndpoint).toBe('http://localhost:9977')
    expect(result.warnings).toEqual([])
  })
})
