# Getting Started

## Goal

Get the web app to a state where a user can:

- open a notebook,
- configure at least one runner or browser execution path,
- run a cell,
- inspect output.

## Minimum prerequisites

- the web app is running,
- a Runme backend is available if the user wants backend runners,
- the user can sign in if the chosen flow requires OIDC or Google Drive auth.

## Fastest successful path

1. Open the app.
2. Open the bottom pane and switch to `App Console`.
3. Configure a runner if needed:

```js
runmeRunners.update("default", "ws://localhost:9977/ws")
runmeRunners.setDefault("default")
```

4. Mount or open a notebook:

```js
explorer.addFolder()
```

Or import a markdown notebook:

```js
explorer.importMarkdown()
```

5. Open a notebook from the explorer.
6. Run a code cell from the notebook UI.

## If AI is needed

- log in first if the harness depends on backend auth,
- configure the active harness if the default is wrong,
- open the AI side panel from the left toolbar.

## High-value facts for Codex

- The default page is the notebook workspace at `/`.
- The app persists runner, harness, and config state in browser storage.
- Local notebooks are first-class. A user does not need Google Drive to start.
- The bottom pane is operationally important. It exposes both `App Console` and
  `Logs`.
