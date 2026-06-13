# Google Drive Integration

## Purpose

Google Drive provides:

- notebook storage,
- folder browsing,
- link opening and sharing,
- upstream sync for Drive-backed notebooks.

## Key model

The editor usually works through a local mirror even for Drive-backed files.
That is intentional.

Benefits:

- local editing remains responsive,
- sync can resume after auth or connectivity recovery,
- the UI can surface pending or error states explicitly.

## Common user actions

- authenticate Drive access,
- mount a Drive link or folder,
- open a Drive notebook,
- save the current notebook to Drive,
- copy a notebook into another Drive folder,
- inspect or requeue pending sync.

## Controlling Drive auth behavior

Drive auth is configured separately from the app's main OIDC login.

Runtime config under `googleDrive` controls both:

- which OAuth flow is used,
- and how the browser hands the user off to Google.

Example:

```yaml
googleDrive:
  clientID: "<google-drive-client-id>"
  clientSecret: ""
  authFlow: "implicit"
  authUxMode: "new_tab"
```

Meaning:

- `authFlow: "implicit"` asks Google for an access token directly in the browser.
- `authFlow: "pkce"` uses the authorization-code flow and exchanges the code after the callback.
- `authFlow: "service_account"` mints short-lived OAuth access tokens from a
  Google Cloud service account private key. Use this only for local or automated
  testing with tightly scoped Drive folders; do not ship browser deployments
  that expose production private keys.
- `authUxMode: "popup"` uses the Google Identity Services popup flow.
- `authUxMode: "redirect"` redirects the current tab to Google and back.
- `authUxMode: "new_tab"` opens the Drive auth flow in a separate tab and is the default.

Recommended defaults:

- Use `implicit` + `new_tab` for the least disruptive browser UX.
- Use `pkce` + `new_tab` when you want authorization-code flow semantics but still want to avoid taking over the current tab.
- Use `service_account` for automated tests that need Drive access without human
  consent. Share the target test Drive folder with the service account email.
- Use `redirect` only when you explicitly want the current tab to navigate through the OAuth flow.

Service account example:

```yaml
googleDrive:
  authFlow: "service_account"
  serviceAccount:
    client_email: "<service-account>@<project>.iam.gserviceaccount.com"
    private_key_id: "<key-id>"
    private_key: |
      -----BEGIN PRIVATE KEY-----
      ...
      -----END PRIVATE KEY-----
```

## Useful App Console commands

```js
drive.help()
await drive.authorize()
await drive.refreshAuth()
drive.list(folderIdOrUri)
drive.create(folderIdOrUri, "name.json")
drive.trash(fileIdOrUri)
drive.saveAsCurrentNotebook(folderIdOrUri, "name.json")
drive.copyNotebook(sourceIdOrUri, targetFolderIdOrUri, "name.json")
drive.listPendingSync()
drive.requeuePendingSync()
```

`drive.authorize()` starts a fresh Google Drive OAuth flow. It first clears any
locally stored Drive OAuth handoff state from a previous redirect or new-tab
attempt, then starts the flow configured by `googleDrive.authFlow` and
`googleDrive.authUxMode`.

Use this when the Drive status button appears stuck, when an agent needs to
explicitly refresh Drive auth from App Console, or before asking a user to clear
browser storage manually. `drive.refreshAuth()` is an alias for the same
operation.

`drive.trash(fileIdOrUri)` moves a Google Drive file to Drive trash. It is
available in browser AppKernel JavaScript, including App Console and browser JS
notebook cells, and is intentionally not exposed in the AppKernel sandbox. For
bulk cleanup, have Codex insert a browser JS notebook cell that lists candidate
files first, then review and run the trash command manually:

```js
const files = await drive.list(folderIdOrUri)
const targets = files.filter(
  (item) => item.type === "file" && item.name.toLowerCase().startsWith("untitled"),
)
console.table(targets)
// After review:
// for (const item of targets) await drive.trash(item.uri)
```

Optional arguments:

```js
await drive.authorize({ mode: "new_tab" })
await drive.authorize({ mode: "redirect" })
await drive.authorize({ mode: "popup", prompt: "consent" })
```

`mode` can be `"new_tab"`, `"redirect"`, or `"popup"`. `prompt` can be
`"none"` or `"consent"`.

## High-value facts for Codex

- Drive auth and OIDC auth are related but not identical flows.
- A Drive-backed notebook may be healthy locally while upstream sync is blocked.
- For user support, the sync state is often more important than the raw Drive API call.
