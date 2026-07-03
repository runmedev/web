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
- create or open an Excalidraw diagram in a Drive folder,
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

Service-account credentials loaded from App Console are saved in
`localStorage.googleClientConfig` so automated local sessions continue working
after a reload. This is convenient for tests but means the private key is stored
in browser-accessible storage. Keep these keys tightly scoped to disposable test
Drive folders and prefer a server-side token broker for production.

## Excalidraw diagrams in Drive

Drive-backed workspace folders can contain Excalidraw diagrams alongside Runme
notebooks. Runme stores each diagram as a normal Drive file with an Excalidraw
JSON scene body.

Supported file names:

- `*.excalidraw`
- `*.excalidraw.json`

Runme creates new diagrams with this MIME type:

```text
application/vnd.excalidraw+json
```

To create a diagram:

1. Mount a Google Drive folder in the workspace explorer.
2. Right-click the mounted Drive folder.
3. Select `New Excalidraw Diagram`.
4. Rename the new explorer entry if needed.
5. Open the diagram and draw in the Excalidraw tab.

New diagrams appear in the explorer immediately through the local mirror. Runme
then creates the backing Drive file asynchronously and updates the local row
with the Drive URI. The editor autosaves changes back to the backing Drive file
after a short debounce. The tab header shows `Ready`, `Saving...`, or
`Saved to Drive`.

Existing `.excalidraw` files appear in Drive-backed folders and open as
workspace document tabs. The tab URI remains the local mirror URI
(`local://file/<uuid>`); the file's MIME type or filename selects the
Excalidraw renderer.

Current limitations:

- diagram creation is Drive-only,
- concurrent edits are last-writer-wins,
- there is no PNG/SVG export action yet.

## Useful App Console commands

```js
drive.help()
await drive.authorize()
await drive.refreshAuth()
drive.list(folderIdOrUri)
drive.search(filesListRequest)
drive.create(folderIdOrUri, "name.json")
drive.trash(fileIdOrUri)
drive.saveAsCurrentNotebook(folderIdOrUri, "name.json")
drive.copyNotebook(sourceIdOrUri, targetFolderIdOrUri, "name.json")
drive.listPendingSync()
drive.requeuePendingSync()
```

### Search Drive with native query syntax

`drive.search(request)` passes `request` directly to the Google Drive v3
[`files.list`](https://developers.google.com/drive/api/reference/rest/v3/files/list)
API. Use the native Drive `q` grammar and list parameters, including `corpora`,
`driveId`, `spaces`, `orderBy`, `pageSize`, `pageToken`, and `fields`:

```js
const result = await drive.search({
  q: "name = 'eval_read.json' and trashed = false",
  orderBy: 'modifiedTime desc',
  pageSize: 100,
  fields:
    'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,modifiedTime)',
})

console.table(result.files)
```

Runme preserves the file metadata requested in `fields` and adds a `uri` to
each result when `id` and `mimeType` are present. That URI can be passed to the
notebook APIs without constructing a Drive URL:

```js
if (result.files.length !== 1) {
  throw new Error(`Expected one notebook, found ${result.files.length}`)
}
await notebooks.show(result.files[0].uri)
```

Use `nextPageToken` to retrieve every matching file:

```js
const files = []
let pageToken

do {
  const page = await drive.search({
    q: "mimeType != 'application/vnd.google-apps.folder' and trashed = false",
    pageSize: 1000,
    pageToken,
    fields: 'nextPageToken,files(id,name,mimeType)',
  })
  files.push(...page.files)
  pageToken = page.nextPageToken
} while (pageToken)
```

For a shared drive, use the same parameters required by the Drive API:

```js
const result = await drive.search({
  q: "name contains 'evaluation' and trashed = false",
  corpora: 'drive',
  driveId: '<shared-drive-id>',
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
  fields: 'nextPageToken,files(id,name,mimeType,parents)',
})
```

`drive.list(folderIdOrUri)` remains the simpler choice for listing one known
folder. Use `drive.search` when the caller needs Drive query expressions,
pagination, ordering, shared-drive scoping, or additional file metadata.

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
