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
- `explorer`: workspace and file-mount helpers,
- `runmeRunners`: runner configuration,
- `jupyter`: Jupyter server and kernel lifecycle,
- `agent`: backend agent endpoint,
- `drive`: Drive file and sync helpers,
- `oidc`: sign-in configuration and auth inspection,
- `credentials`: shorthand credential managers,
- `app`: app config, harness, Codex project, and related global controls,
- `opfs`: browser private file storage helpers,
- `net`: browser HTTP GET helper.

## Canonical commands

```js
help()
explorer.help()
runme.help()
notebooks.help()
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
await credentials.google.setServiceAccountFromFilePath('/Users/jlewi/secrets/aisre-gdrive-oai-test-8ba1a40f228e.json')
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

App config:

```js
app.getDefaultConfigUrl()
app.setConfig(app.getDefaultConfigUrl())
```

Harness setup:

```js
app.harness.get()
app.harness.getDefault()
app.harness.setDefault('configured-harness-name')
```

## High-value facts for Codex

- The App Console is a supported user surface, not just a developer escape hatch.
- Current namespace names matter. Prefer exact names from code over stale README examples.
- If a user wants an action that has no visible button, check the App Console before saying the feature is missing.
- Prefer `notebooks.appendCell({ kind, ... })` for simple inserts before writing
  raw `notebooks.update(...)` mutations by hand.
- Use `notebooks.resolve(reference)` to turn local URIs, Runme share URLs,
  Drive URLs, and Markdown links into a title, `localUri`, `remoteUri`,
  `shareUrl`, and replacement-ready `markdownLink`.
- Use `notebooks.show(reference)` when Codex needs one command that opens a
  local notebook tab or hands a Drive reference to shared-link coordination.
