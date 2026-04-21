# Authentication And App Configuration

## Distinct configuration domains

Users may need to configure more than one of these:

- OIDC sign-in for the web app,
- Google OAuth for Drive access,
- backend agent endpoint,
- app-config YAML,
- OpenAI or Responses-direct credentials,
- AI harness selection.

## OIDC helpers

```js
oidc.get()
oidc.setGoogleDefaults()
oidc.setClientToDrive()
oidc.setClientId("...")
oidc.setClientSecret("...")
oidc.setDiscoveryURL("...")
oidc.getStatus()
```

## Google Drive OAuth helpers

```js
credentials.google.setClientId("...")
credentials.google.setClientSecret("...")
credentials.google.setAuthFlow("implicit") // or "pkce"
credentials.google.setAuthUxMode("redirect") // or "popup"
```

## App config helpers

```js
app.getDefaultConfigUrl()
app.setConfig(url)
app.setConfigFromYaml(yamlText)
app.setLocalConfigPreferredOnLoad(true)
app.enableConfigOverridesOnLoad()
```

## High-value facts for Codex

- App config can inject defaults for agent endpoint, runner endpoint, OIDC, Drive,
  and ChatKit-related values.
- OIDC auth and Drive auth can share credentials, but they solve different problems.
- If the app loads but features are unavailable, configuration mismatch is a more
  likely cause than a rendering bug.
