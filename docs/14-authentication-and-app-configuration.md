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
await credentials.google.setServiceAccountFromFile()
await credentials.google.setServiceAccountFromFilePath("/Users/jlewi/secrets/aisre-gdrive-oai-test-8ba1a40f228e.json")
```

`drive.authorize()` and `app.startGoogleDriveOAuth()` both start a new Google
Drive OAuth flow from App Console. Before starting the flow, they clear local
OAuth handoff state such as redirect/new-tab state, PKCE verifier state, return
URL, implicit prompt mode, and stored callback errors. This is the supported
recovery path when stale OAuth state prevents the Drive auth button from
launching a new flow.

`drive.refreshAuth()` is an alias for `drive.authorize()`.

## Google Drive service-account auth

For automated tests, app config can select service-account Drive auth:

```yaml
googleDrive:
  authFlow: "service_account"
  serviceAccount:
    client_email: "<service-account>@<project>.iam.gserviceaccount.com"
    private_key: |
      -----BEGIN PRIVATE KEY-----
      ...
      -----END PRIVATE KEY-----
```

This is intended for local/CI testing with a service account shared only into
test Drive folders. Do not expose production service-account keys to browser
deployments.

`setServiceAccountFromFile()` opens a browser file picker and reads a local
service-account JSON key file. Browser JavaScript cannot read arbitrary local
filesystem paths directly.

`setServiceAccountFromFilePath(path)` is available when the app is served by the
local Vite dev server. It asks the dev server to read an absolute `.json` path,
so it is intended for local automation only.

Both service-account helpers persist the loaded credentials in
`localStorage.googleClientConfig` so reloads keep using the same test service
account. Browser storage is not a production secret boundary: IndexedDB is a
better structured persistent store than localStorage, but page JavaScript can
still read data it is authorized to use. Use browser-persisted private keys only
for tightly scoped local/CI testing, and use a trusted token broker for
production.

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
