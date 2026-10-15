---
name: desktop-runtime
title: Runme Desktop and local MCP
order: 22
description: >-
  Build and launch the bundled Electron Runme app, connect Codex to its local
  MCP endpoint, persist notebooks, and optionally package and start a Runme
  runner. Explains local authentication, packaging, and Linux executor usage.
---

# Runme Desktop and local MCP

Runme Desktop packages the production Vite frontend with Electron. Its local
Streamable HTTP MCP server forwards the existing Runme tools to the live app
through an isolated preload bridge. Native WebMCP and its experimental Chromium
flags are not required. The normal web build continues to use WebMCP.

The MCP catalog includes `ExecuteCode`, operation polling/cancellation, AI
instructions, documentation, runner authentication, and Drive tools. Notebook
operations use the same AppKernel handlers and state as the UI. This does not
create a second notebook store or a separate implementation of editing.

## Build and launch

Use Node 22.12+ (or Node 24) and the repository's pinned pnpm. Run from the repo
root. Electron is downloaded for the build machine's platform and architecture.

```sh {"name":"build-desktop"}
pnpm install --frozen-lockfile
pnpm build:desktop
```

```sh {"name":"start-desktop"}
pnpm desktop
```

The app serves bundled assets at `http://127.0.0.1:43124` and MCP at
`http://127.0.0.1:43123/mcp`. Keep the UI port stable: browser storage is scoped
to its origin. The persistent profile defaults to Electron's OS-specific Runme
user-data directory. Startup prints the path to `connection.json`, which contains
the endpoints and token-file location, but not the token itself.

Set `RUNME_DESKTOP_DATA_DIR` to an absolute persistent directory, such as
`/workspace/runme/desktop` in the executor. An existing browser profile or its
credentials are not imported automatically. Notebook tabs are session state;
saved notebooks can be reopened from the workspace after restarting. Normal
app shutdown waits for pending notebook edits to persist. Force-killing the
process cannot provide that guarantee.

## Connect Codex

The app creates a random token in `<profile>/mcp-token` with owner-only file
permissions. MCP requires this bearer token, validates Host, rejects browser
Origin headers, and binds only IPv4 loopback. Treat this token as authority to
operate Runme, including executing notebooks. It is separate from runner auth.

With the desktop app running, set the profile path you chose:

```sh {"name":"connect-desktop-mcp"}
export RUNME_DESKTOP_DATA_DIR=/workspace/runme/desktop
export RUNME_MCP_TOKEN="$(cat "$RUNME_DESKTOP_DATA_DIR/mcp-token")"
codex mcp add runme --url http://127.0.0.1:43123/mcp \
  --bearer-token-env-var RUNME_MCP_TOKEN
```

The process hosting Codex's MCP client must inherit `RUNME_MCP_TOKEN`. For a
GUI client started separately, configure its environment accordingly. Localhost
refers to that client's network namespace; a client outside the executor needs
explicit forwarding. The app does not publish an external endpoint.

Read `ReadInstructionsForAIAgents` first. For example, call `ExecuteCode` with:

```json
{
  "code": "const doc = await notebooks.createLocal('hello.runme'); await notebooks.appendCell({ target: { handle: doc.handle }, kind: 'markup', value: '# Hello from MCP' }); await notebooks.show(doc.handle.uri); console.log(doc.handle.uri);",
  "timeoutMs": 1000
}
```

If the response reports `running`, poll `GetExecuteCodeOperation` with the
returned `operationId`. A disconnect or cancellation does not roll back edits;
inspect state before retrying a mutation. The transport waits at most two
minutes per tool call; long code operations use the existing polling API.

## Bundle or connect a runner

The frontend and MCP work without a Go runner, including AppKernel JavaScript
and local notebook editing. Shell execution requires a configured runner.
By default the app points to an independently managed runner on
`http://127.0.0.1:9988` (`ws://127.0.0.1:9988/ws`).

To include the Go executable in the distribution, supply a binary built for
the same OS and architecture as Electron. The build copies it; it does not
compile Go or embed credentials/configuration:

```sh {"name":"package-desktop-with-runner"}
export RUNME_RUNNER_BINARY=/absolute/path/to/runme
pnpm package:desktop
```

Outputs appear in `packages/desktop/release/`. On macOS launch
`Runme.app/Contents/MacOS/runme-desktop`; on Linux launch `runme-desktop` in the
output directory. These are unsigned application bundles, not signed installers.
Build on the target platform; cross-compiling the runner is not performed.

To have the app supervise the bundled runner, set `RUNME_RUNNER_CONFIG` to an
absolute runner YAML path before launch. An optional `RUNME_RUNNER_BINARY`
overrides the bundled executable. The app launches `runme agent serve --config
<path>` and terminates that child on shutdown. Missing configuration means no
runner is started; a supplied config with a missing binary fails startup.
Runner startup failure exits the app. Existing runners are never killed.

Provide the runner's normal authentication configuration and allow the exact UI
origin `http://127.0.0.1:43124` in its CORS policy. Use `configureRunnerAuth`
through MCP to import a provisioned signing key. No authentication is disabled
and no signing key is copied into the package.

`RUNME_APP_CONFIG` can point to a public `app-configs.yaml` with different runner
endpoints or workload identity configuration. It is served to the renderer;
never put private keys or tokens there. For Drive use the existing runner-backed
workload identity tools. Interactive OAuth popups and external navigation are
currently blocked in the desktop host; there is no new desktop OAuth callback
integration in this implementation.

## Executor and diagnostics

Set `RUNME_DESKTOP_HIDDEN=1` to hide the window. This is Electron's hidden-window
mode, not Chromium's headless mode. Linux still requires a display server and
Electron's system libraries; an executor can use Xvfb. Chromium's sandbox,
context isolation, and same-origin protections remain enabled. Environments
that prohibit Electron's sandbox need their runtime configured appropriately;
this launcher does not add `--no-sandbox`.

`RUNME_UI_PORT` and `RUNME_MCP_PORT` override the default ports. Port `0` is
intended only for isolated tests, since changing the UI origin changes storage.
Only one process may use a profile. Closing the window stops the app and MCP.

```sh {"name":"test-desktop"}
pnpm test:desktop
pnpm smoke:desktop
```

The smoke test uses a temporary isolated Electron profile and the real MCP
client, creates a notebook, verifies it in the UI, restarts to verify persistence,
and reloads to verify tool re-registration. It does not require cloud credentials
or a fake backend. Artifacts go to `app/test/browser/test-output/desktop/`.
To test a packaged executable, set `RUNME_DESKTOP_EXECUTABLE` to its absolute
path before running `pnpm smoke:desktop`.
