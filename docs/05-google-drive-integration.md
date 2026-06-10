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
- `authUxMode: "popup"` uses the Google Identity Services popup flow.
- `authUxMode: "redirect"` redirects the current tab to Google and back.
- `authUxMode: "new_tab"` opens the Drive auth flow in a separate tab and is the default.

Recommended defaults:

- Use `implicit` + `new_tab` for the least disruptive browser UX.
- Use `pkce` + `new_tab` when you want authorization-code flow semantics but still want to avoid taking over the current tab.
- Use `redirect` only when you explicitly want the current tab to navigate through the OAuth flow.

## Useful App Console commands

```js
drive.help()
await drive.authorize()
await drive.refreshAuth()
drive.list(folderIdOrUri)
drive.create(folderIdOrUri, "name.json")
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
