---
name: authentication-and-app-configuration
title: Authentication And App Configuration
order: 13
description: >-
  Use this guide to distinguish and configure Runme's authentication and
  application settings. It covers OIDC sign-in, Google OAuth, Drive service
  accounts, backend agent endpoints, and app configuration URLs, with the
  corresponding App Console helpers. Use the Google Drive integration guide
  for Drive storage behavior after credentials are configured.
---

# Authentication And App Configuration

## Distinct configuration domains

Users may need to configure more than one of these:

- OIDC sign-in for the web app,
- Google OAuth for Drive access,
- backend agent endpoint,
- app-config YAML.

## OIDC helpers

```js
oidc.get()
oidc.setGoogleDefaults()
oidc.setClientToDrive()
oidc.setClientId('...')
oidc.setClientSecret('...')
oidc.setDiscoveryURL('...')
oidc.getStatus()
```

## Application login UI

For Google OIDC with no client secret, browser login uses Google's implicit
`id_token token` response. Runme verifies the signed ID token and callback before
storing credentials. This flow has no refresh token; sign in again when the
tokens expire. Other OIDC providers and configurations with a client secret
continue to use authorization code with PKCE.

Google Drive authentication is configured separately. Never put client secrets
or private keys in an app-config YAML served as a public asset. Deleting a secret
from the current file does not revoke copies in Git history.

See [Google's OIDC flow documentation](https://developers.google.com/identity/openid-connect/openid-connect#authenticationuriparameters).

Open **Authentication Settings** from the key icon in the left navigation. The
panel groups the settings and actions for:

- Runme account identity,
- Google Drive account identity,
- Google Drive OAuth flow and browser interaction mode,
- Google Drive OAuth client, and
- Runme OIDC client, discovery URL, and scopes.

The Runme account section supports:

- **Direct principal** — run the normal OIDC flow and authenticate as the
  selected human principal.
- **Service account** — select a human principal interactively, then mint
  short-lived Drive and Runme credentials for the configured service-account
  email.

The account icon remains a simple sign-in/sign-out action and uses the identity
mode saved in Authentication Settings. Runme remembers the selected mode,
service-account email, and generated short-lived service-account credentials.
The human OAuth access token used to authorize impersonation remains in memory
and is never written to browser storage.

## Google Drive OAuth helpers

```js
credentials.google.setClientId('...')
credentials.google.setClientSecret('...')
credentials.google.setAuthFlow('implicit') // or "pkce"
credentials.google.setAuthUxMode('redirect') // or "popup"
await drive.authorize()
await drive.refreshAuth()
await app.startGoogleDriveOAuth()
await credentials.google.setServiceAccountFromFile()
await credentials.google.setServiceAccountFromFilePath(
  '/Users/jlewi/secrets/aisre-gdrive-oai-test-8ba1a40f228e.json'
)
await credentials.google.getServiceAccountCredentials(
  '<service-account>@<project>.iam.gserviceaccount.com',
  {
    authorizationLeaseSeconds: 24 * 60 * 60,
  }
)
```

`drive.authorize()` and `app.startGoogleDriveOAuth()` both start a new Google
Drive OAuth flow from App Console. Before starting the flow, they clear local
OAuth handoff state such as redirect/new-tab state, PKCE verifier state, return
URL, implicit prompt mode, and stored callback errors. This is the supported
recovery path when stale OAuth state prevents the Drive auth button from
launching a new flow.

`drive.refreshAuth()` is an alias for `drive.authorize()`.

## Google Drive service-account auth

For browser deployments, prefer keyless service-account impersonation:

```js
const status = await credentials.google.getServiceAccountCredentials(
  '<service-account>@<project>.iam.gserviceaccount.com',
  {
    // Defaults to the configured Runme OIDC client ID.
    appAudience: '<runme-oidc-audience>',
    // Product authorization window; maximum seven days.
    authorizationLeaseSeconds: 7 * 24 * 60 * 60,
    // Optional. Defaults to one hour. Values above one hour require the
    // credential lifetime extension organization policy.
    accessTokenLifetimeSeconds: 60 * 60,
    prompt: 'select_account',
  }
)
```

The interactive human must have `roles/iam.serviceAccountTokenCreator` on the
specific target service account. The flow requests a short-lived human Google
OAuth token, then uses the IAM Service Account Credentials API to mint:

- a Drive-scoped OAuth access token; and
- an audience-bound OIDC ID token for the Runme Agent.

Enable both APIs before connecting:

- **IAM Service Account Credentials API** in the OAuth client or quota project;
  and
- **Google Drive API** (`drive.googleapis.com`) in the target service account's
  Google Cloud project.

Sharing a Drive folder with the service account does not enable the Drive API.
IAM can still mint a correctly scoped access token while the Drive API is
disabled, but every Drive operation then fails with `403 SERVICE_DISABLED`.
Runme validates a newly minted Drive token before reporting Drive as syncing.
If validation detects this configuration, Authentication Settings and the
Drive status action show an error with a direct link to enable the API for the
affected project. After enabling it, allow a few minutes for propagation and
then use **Connect or refresh** to mint and validate a new credential.

#### Service-account storage and Shared drives

An impersonated service account is still the service-account principal; it is
not a Google Workspace user acting through domain-wide delegation. Service
accounts do not have Drive storage quota and cannot own files in a user's **My
Drive**. Sharing a My Drive folder with the service account can permit reading,
editing, or moving existing files, but it does not let the service account
create files that it would need to own. Google reports this as
`403 storageQuotaExceeded`, often with a message that service accounts do not
have storage quota.

To create notebooks with service-account credentials, select a folder in an
actual **Shared drive**, where the organization owns the files. A folder shared
from a user's My Drive is not a Shared drive. Add the service-account email as
a Shared drive member with **Contributor** access to create files. Use **Content
manager** or **Manager** when Runme also needs to move or delete items within
the Shared drive. Workspace policies must allow the service account to be
added, which can be governed as external membership.

Runme sends the Shared drive parameters required by the Drive API. When Google
returns the service-account `storageQuotaExceeded` response during creation,
Runme explains the ownership limitation and directs the user to choose a Shared
drive or authenticate as a human user. Normal user OAuth, or domain-wide
delegation that truly impersonates a Workspace user, can create files in that
user's My Drive because the human user owns the resulting files.

Both tokens represent the same service-account email. The short-lived
service-account credentials are persisted locally so they survive the OAuth
redirect and reloads; the human OAuth token is not persisted. Switching to the
service account clears persisted human Drive and OIDC credentials so expiry
cannot silently fall back to the human.

Runme requests a one-hour impersonated access token by default. Callers may
explicitly request up to 12 hours when the target service account is allowed by
the `constraints/iam.allowServiceAccountCredentialLifetimeExtension`
organization policy. Runme surfaces an actionable error when Google rejects an
extended lifetime.

`authorizationLeaseSeconds` records the intended reauthorization window but is
not a security boundary by itself. Enforce a one-to-seven-day privilege window
with an expiring IAM condition, Privileged Access Manager, or a trusted token
broker. The current browser implementation does not automatically refresh the
generated credentials after their Google expiration; rerun the helper to
reauthorize and mint fresh tokens.

### Legacy JSON-key flow

For automated tests, app config can select service-account Drive auth:

```yaml
googleDrive:
  authFlow: 'service_account'
  serviceAccount:
    client_email: '<service-account>@<project>.iam.gserviceaccount.com'
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

## Key facts

- App config can inject defaults for agent endpoint, runner endpoint, OIDC, and
  Drive values.
- OIDC auth and Drive auth can share credentials, but they solve different problems.
- If the app loads but features are unavailable, configuration mismatch is a more
  likely cause than a rendering bug.
