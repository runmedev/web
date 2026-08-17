---
name: app-console-reference
title: App Console Reference
order: 12
description: >-
  Use this reference to discover supported App Console namespaces and canonical
  JavaScript helpers for notebooks, documents, runners, Drive, authentication,
  comments and anchors, configuration, and diagnostics. It includes practical
  command examples for creating or opening notebooks and inspecting runtime
  state. Prefer a task-specific guide when conceptual setup or troubleshooting
  context is more important than API lookup.
---

# App Console Reference

## Purpose

The App Console is the fastest way to inspect and change runtime state from
inside the web app.

Start with:

```js
help()
```

## High-value namespaces

- `runme`: notebook helpers,
- `notebooks`: notebook document API,
- `documents`: raw URI-based document content API,
- `documentation`: read-only, versioned Runme documentation discovery,
- `comments`: Drive comment threads and Runme anchor resolution,
- `ui`: semantic helpers for selecting rendered Markdown and opening Runme UI,
- `explorer`: workspace and file-mount helpers,
- `runmeRunners`: runner configuration,
- `jupyter`: Jupyter server and kernel lifecycle,
- `agent`: backend agent endpoint,
- `drive`: Drive file and sync helpers,
- `oidc`: sign-in configuration and auth inspection,
- `credentials`: shorthand credential managers,
- `app`: app config and related global controls,
- `opfs`: browser private file storage helpers,
- `net`: browser HTTP GET helper.

## Canonical commands

```js
help()
explorer.help()
runme.help()
notebooks.help()
documents.help()
documentation.help()
comments.help()
ui.help()
runmeRunners.help()
drive.help()
agent.help()
```

## Minimal setup examples

Create a local notebook and append cells:

```js
const created = await notebooks.createLocal('helloworld')
await notebooks.appendCell({
  target: { handle: created.handle },
  kind: 'code',
  languageId: 'python',
  value: 'print("hello world")',
})
await notebooks.appendCell({
  target: { handle: created.handle },
  kind: 'markup',
  value: '# Notes',
})
```

Resolve and open notebook references:

```js
await notebooks.resolve('local://file/cb1c8a9f-6dad-4e1a-9cbc-467ddebc3018')
await notebooks.markdownLink(
  'local://file/cb1c8a9f-6dad-4e1a-9cbc-467ddebc3018'
)
await notebooks.show(
  'https://runme.gateway.unified-0.internal.api.openai.org/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F149JKKTgljRiwszwb06Ms74GOYhCOPMNg%2Fview'
)
await notebooks.show(
  '[Notebook](https://drive.google.com/file/d/149JKKTgljRiwszwb06Ms74GOYhCOPMNg/view)'
)
```

Request write access when another Runme session owns a notebook:

```js
const doc = await notebooks.get()
const writable = await notebooks.requestWriteAccess({
  target: { uri: doc.handle.uri },
})
console.log(writable.summary.readOnly)
```

The request uses the same cooperative takeover path as the
**Request write access** button. The owner saves pending changes before
releasing its lock. Continue mutating the notebook only when the returned
document has `summary.readOnly === false`.

Discover and read versioned Runme documentation:

```js
const available = await documentation.list()
console.log(available)
const guide = await documentation.get('getting-started')
console.log(guide)
```

`await documentation.list()` returns compact `{ name, description }` entries.
`documentation.get(name)` fetches the selected Markdown from the commit-pinned
GitHub URL for the running app version.

List and resolve comments on a Drive-backed notebook:

```js
const doc = await notebooks.get()
const target = { uri: doc.handle.uri }
const annotations = await comments.list({ target, status: 'open' })
console.log(JSON.stringify(annotations, null, 2))
```

Each annotation includes the original rendered target, current editable source
ranges, resolution status, and a `sync` field. `pending`, `syncing`, and
`failed` annotations are durable local operations that may not yet be visible
to collaborators in Google Drive. Use `comments.parseAnchor(anchor)` and
`comments.resolveAnchor({ anchor, source })` for standalone anchor inspection.
Reply, resolve, or reopen only when the user requested that collaboration
action:

```js
await comments.reply({ target, commentId, content: 'Addressed.' })
await comments.resolve({ target, commentId })
await comments.reopen({ target, commentId })
```

These mutations persist locally before returning and reconcile with Google
Drive asynchronously. Top-level comments are desired state identified by a
`clientCommentId` in the Drive anchor, so Runme can detect an already-created
comment after an interrupted response. Drive replies have no writable metadata
field, so Runme appends a compact visible footer such as
`[runme:v1;reply=<clientReplyId>]`. This lets Runme reconcile replies by stable
identity while keeping the protocol transparent in Drive's native UI; Runme
strips a valid terminal footer in its own UI. Call `comments.list` again when
remote completion matters and inspect `sync.status` (`pending`, `syncing`,
`uncertain`, `failed`, or `synced`).

The same namespace is available inside WebMCP `ExecuteCode`. Runme does not
register a comment-specific WebMCP tool.

Programmatically exercise the rendered Markdown selection flow through the
semantic `ui` library:

```js
const doc = await notebooks.get()
const notebookUri = doc.summary.uri
const cellId = doc.notebook.cells.find((cell) =>
  cell.value.includes('migration guide')
).refId

const prepared = await ui.prepareRenderedComment({
  target: { uri: notebookUri },
  cellId,
  selector: {
    type: 'TextQuoteSelector',
    exact: 'migration guide',
    prefix: 'Read the ',
    suffix: ' today.',
  },
})
console.log(JSON.stringify(prepared, null, 2))

// Inspect or interact with the open "Comment on selected text" menu, then:
await ui.clearSelection()
```

`ui.selectRenderedMarkdown(request)` creates a native browser `Selection`
without opening a menu. Calling `ui.openContextMenu` with `anchor: 'selection'`
then dispatches the same custom context-menu path used by a user right-click.
`ui.prepareRenderedComment(request)` combines both steps.
The selector is expressed over the versioned rendered Markdown text projection
and may be either a W3C-style `TextQuoteSelector` or a code-point-based
`TextPositionSelector`.

The helpers require the exact active notebook URI and canonical cell `refId`.
They fail instead of guessing when a quote is missing or ambiguous, the cell is
in source-edit mode, or the rendered DOM is stale. They are ephemeral: they do
not create or submit a comment. A synthetic event can validate Runme's custom
menu and anchor-capture path, but it is not a substitute for a manual test of
physical pointer selection or the browser's native menu.

Read and update raw document content, including Excalidraw scenes:

```js
const doc = await documents.get(
  'local://file/cb1c8a9f-6dad-4e1a-9cbc-467ddebc3018'
)
const scene = JSON.parse(doc.content)
scene.elements.push({
  id: crypto.randomUUID(),
  type: 'text',
  x: 120,
  y: 80,
  width: 80,
  height: 25,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: Date.now(),
  version: 1,
  versionNonce: Date.now(),
  isDeleted: false,
  boundElements: null,
  updated: Date.now(),
  link: null,
  locked: false,
  text: 'Box A',
  fontSize: 20,
  fontFamily: 5,
  textAlign: 'left',
  verticalAlign: 'top',
  containerId: null,
  originalText: 'Box A',
  lineHeight: 1.25,
})
await documents.update(doc.uri, JSON.stringify(scene, null, 2), {
  mimeType: doc.mimeType,
})
```

Embed image bytes in the current or a targeted notebook:

```js
await embed('/tmp/screenshot.png', { alt: 'Settings dialog' })
await notebooks.embed('https://example.com/diagram.png', {
  target: { uri: 'local://file/cb1c8a9f-6dad-4e1a-9cbc-467ddebc3018' },
  name: 'architecture.png',
})
```

The command appends a non-runnable HTML cell containing an inline image data
URL. It accepts browser `File`/`Blob` objects, image data URLs, HTTP(S) URLs,
and absolute local paths when the Vite development server is running. Images
larger than 10 MiB are rejected.

Runner setup:

```js
runmeRunners.ensure('default', 'ws://localhost:9977/ws', { setDefault: true })
```

OIDC + Drive setup:

```js
oidc.setGoogleDefaults()
oidc.setClientToDrive()
credentials.google.setClientId('...')
credentials.google.setClientSecret('...')
await credentials.google.setServiceAccountFromFile()
await credentials.google.setServiceAccountFromFilePath(
  '/Users/jlewi/secrets/aisre-gdrive-oai-test-8ba1a40f228e.json'
)
```

Start or refresh Google Drive OAuth:

```js
await drive.authorize()
await drive.refreshAuth()
await app.startGoogleDriveOAuth()
```

These commands clear stale Drive OAuth handoff state before starting a new
Google OAuth flow. They are useful when the Drive status button does not appear
to launch auth, or when a human or agent needs an explicit auth refresh from App
Console.

Search Google Drive with the complete Drive v3 `files.list` request surface:

```js
const result = await drive.search({
  q: "name = 'example.runme.md' and trashed = false",
  orderBy: 'modifiedTime desc',
  pageSize: 100,
  fields:
    'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,modifiedTime)',
})
console.table(result.files)
await notebooks.show(result.files[0].uri)
```

The request is passed through unchanged, so use Google Drive's native `q`,
corpora, shared-drive, ordering, pagination, spaces, and fields parameters.
Include `id` and `mimeType` in `fields` when the returned file should have a
Runme-ready `uri`. Continue with `result.nextPageToken` when it is present.

App config:

```js
app.getDefaultConfigUrl()
app.setConfig(app.getDefaultConfigUrl())
```

## Key facts

- The App Console is a supported user surface, not just a developer escape hatch.
- Current namespace names matter. Prefer exact names from code over stale README examples.
- If a user wants an action that has no visible button, check the App Console before saying the feature is missing.
- Prefer `notebooks.appendCell({ kind, ... })` for simple inserts before writing
  raw `notebooks.update(...)` mutations by hand.
- Use `embed(source, options)` or `notebooks.embed(source, options)` to preserve
  screenshots and other image bytes as authored notebook content.
- Use `documents.get(uri)` and `documents.update(uri, content, options)` for
  raw content edits to non-notebook documents such as Excalidraw diagrams.
- Use `notebooks.resolve(reference)` to turn local URIs, Runme share URLs,
  Drive URLs, and Markdown links into a title, `localUri`, `remoteUri`,
  `shareUrl`, and replacement-ready `markdownLink`.
- Use `notebooks.show(reference)` when automation needs one command that opens a
  local notebook tab or hands a Drive reference to shared-link coordination.
- Prefer `drive.search(...)` over DOM inspection when automation knows a Drive file
  name or can express the intended file with the Drive query grammar. Resolve a
  unique result, then pass its `uri` to `notebooks.show(...)`.
