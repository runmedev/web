// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})
it('persists explicit flow and interaction across manager recreation', async () => {
  const { oidcConfigManager } = await import('./oidcConfig')
  oidcConfigManager.setConfig({
    discoveryUrl: 'https://issuer.example/discovery',
    clientId: 'client',
    scope: 'openid email',
    authFlow: 'pkce',
    authUxMode: 'new_tab',
  })
  vi.resetModules()
  const reloaded = await import('./oidcConfig')
  expect(reloaded.getOidcConfig()).toMatchObject({
    authFlow: 'pkce',
    authUxMode: 'new_tab',
  })
})
it('keeps legacy defaults but honors explicit PKCE for secret-free Google', async () => {
  const { effectiveOidcAuthFlow } = await import('./oidcConfig')
  const config = {
    discoveryUrl:
      'https://accounts.google.com/.well-known/openid-configuration',
    clientId: 'client',
    scope: 'openid',
    redirectUri: 'http://localhost/oidc/callback',
  }
  expect(effectiveOidcAuthFlow(config)).toBe('implicit')
  expect(effectiveOidcAuthFlow({ ...config, authFlow: 'pkce' })).toBe('pkce')
  expect(
    effectiveOidcAuthFlow({ ...config, discoveryUrl: 'https://issuer.example' })
  ).toBe('pkce')
})
it('applies YAML options and retains them when local precedence is enabled', async () => {
  const { setAppConfigFromYaml } = await import('../lib/appConfig')
  const yaml = `oidc:\n  generic:\n    discoveryUrl: https://issuer.example/discovery\n    clientId: client\n    scopes: [openid, email]\n    authFlow: pkce\n    authUxMode: popup\n`
  expect(setAppConfigFromYaml(yaml).oidc).toMatchObject({
    authFlow: 'pkce',
    authUxMode: 'popup',
  })
  expect(
    setAppConfigFromYaml(yaml.replace('popup', 'redirect'), undefined, {
      preserveLocalConfiguration: true,
    }).oidc
  ).toMatchObject({ authUxMode: 'popup' })
})
it('rejects invalid YAML flow options', async () => {
  const { setAppConfigFromYaml } = await import('../lib/appConfig')
  expect(() =>
    setAppConfigFromYaml('oidc:\n  generic:\n    authFlow: typo')
  ).toThrow('Unsupported Runme OAuth option')
})
