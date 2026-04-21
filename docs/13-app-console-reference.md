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
drive.help()
agent.help()
```

## Minimal setup examples

Runner setup:

```js
runmeRunners.update("default", "ws://localhost:9977/ws")
runmeRunners.setDefault("default")
```

OIDC + Drive setup:

```js
oidc.setGoogleDefaults()
oidc.setClientToDrive()
credentials.google.setClientId("...")
credentials.google.setClientSecret("...")
```

App config:

```js
app.getDefaultConfigUrl()
app.setConfig(app.getDefaultConfigUrl())
```

Harness setup:

```js
app.harness.update("browser-codex", "", "codex-wasm")
app.harness.setDefault("browser-codex")
```

## High-value facts for Codex

- The App Console is a supported user surface, not just a developer escape hatch.
- Current namespace names matter. Prefer exact names from code over stale README examples.
- If a user wants an action that has no visible button, check the App Console before saying the feature is missing.
