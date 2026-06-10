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
await drive.authorize()
await drive.refreshAuth()
await app.startGoogleDriveOAuth()
```

`drive.authorize()` and `app.startGoogleDriveOAuth()` both start a new Google
Drive OAuth flow from App Console. Before starting the flow, they clear local
OAuth handoff state such as redirect/new-tab state, PKCE verifier state, return
URL, implicit prompt mode, and stored callback errors. This is the supported
recovery path when stale OAuth state prevents the Drive auth button from
launching a new flow.

`drive.refreshAuth()` is an alias for `drive.authorize()`.

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
