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
root. By default Electron is downloaded for the build machine's platform and architecture.

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

Read `readInstructionsForAIAgents` first. For example, call `ExecuteCode` with:

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
Linux bundles can also be assembled on macOS; the Go runner must be built separately for the target.

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
never put private keys or tokens there. An explicit file replaces the generated default configuration, including the Google Drive provider described below. Interactive OAuth popups and external navigation are
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

## One tool interface for web and desktop

`WebMcpToolRegistrationHost` registers the application tools once. In a browser,
it registers with `navigator.modelContext`; in Electron, the same registration
code uses `createDesktopToolContext`. That adapter keeps the handlers in the
renderer and publishes their JSON descriptors over the isolated preload.
`tools/list` returns this live catalog. `tools/call` forwards the name and
arguments to the same handler and wraps its result string as MCP text content.
There is no desktop-only notebook tool catalog or schema generation pipeline.

Names, titles, descriptions, input schemas, and annotations are identical on
the wire. WebMCP-specific annotations are preserved even though some MCP SDK
clients strip hints outside their own schema. Registration parity and transport
regression tests protect this contract. A new tool added to the registration
host automatically appears in both environments.

The initial transport is stateless HTTP: it does not advertise tool-list-change
notifications. Clients should list tools again after renderer reload. During
startup or reload, discovery reports that the app is loading. In-flight calls
fail on renderer loss; mutations are never automatically retried.

## Google Drive using the pod's workload identity

Choose the token mode in the **host environment** before starting the app. For a
pod whose default metadata identity already has Drive access:

```sh
export RUNME_GOOGLE_SERVICE_ACCOUNT=olympus-executor@olympus-executor-prod-449501.iam.gserviceaccount.com
export RUNME_GOOGLE_SCOPES=https://www.googleapis.com/auth/drive
export RUNME_GOOGLE_TOKEN_MODE=metadata_direct
```

This enables `gke_metadata` and generates the matching public Drive configuration
at startup. No Google token or key is packaged or persisted. If using
`RUNME_APP_CONFIG`, include the following in that file; the host environment
above still pins the mode, identity, and allowed scopes:

```yaml
googleDrive:
  authFlow: workload_identity
  provider: gke_metadata
  tokenMode: metadata_direct
  expectedServiceAccountEmail: olympus-executor@olympus-executor-prod-449501.iam.gserviceaccount.com
  scopes:
    - https://www.googleapis.com/auth/drive
```

The `configureGoogleWorkloadIdentity` tool accepts the same fields as this
`googleDrive` object. WebMCP and desktop MCP expose the identical schema;
`gke_metadata` fails clearly outside the supported desktop host. `runnerName`
is required only for the default `runner` provider.

In `metadata_direct` mode, Electron's main process first reads the default
metadata service account's `/email` and checks it against the pinned expected
identity. It then requests `/token?scopes=...` using the configured scopes and
`Metadata-Flavor: Google`. The returned access token is used directly by Drive.
No IAM Credentials API call or self-impersonation permission is required.

**Omit `lifetimeSeconds` in direct mode.** Supplying it is an error, because
metadata does not offer a caller-selected lifetime. Expiry comes from
`expires_in`, measured from request start. Tokens are cached only in memory and
refreshed before expiry (the smaller of two minutes or 20% of remaining life).
Concurrent requests coalesce; forced refresh discards the cached token and
joins an already-running acquisition if present.

`iam_exchange` remains the default when the mode is omitted, preserving existing
configurations. Set `RUNME_GOOGLE_TOKEN_MODE=iam_exchange` and use
`tokenMode: iam_exchange` (or omit it) to obtain a metadata credential and exchange
it through IAM Credentials `generateAccessToken` for the pinned target account.
This mode accepts `lifetimeSeconds` from 60 to 3600, defaulting to 900. It requires
the IAM Service Account Credentials API and
`iam.serviceAccounts.getAccessToken` on the target account; the metadata caller
may be a different identity. Only the exchanged token reaches the renderer.

All metadata and IAM requests run in Electron's main process through the narrow
preload bridge, with fixed endpoints and redirects disabled. The renderer cannot
choose another metadata host, token mode contrary to host policy, target account,
or broader scope. Notebook tools return authentication status, never raw tokens.
Failures never fall back to another mode, identity, runner, or interactive OAuth.
No `--disable-web-security` flag or browser metadata fetch is needed.

Provision GKE Workload Identity separately and share the relevant Drive files,
folders, or Shared Drive with the selected GSA. OAuth scopes and IAM permissions
do not grant Drive file access. Use a Shared Drive for creating notebooks because
service accounts cannot own My Drive files.

## Package Linux for executor pods

The packager downloads the target Electron distribution; it does not compile
Chromium. Supported Linux targets are `x64` and `arm64`. It rejects a runner
whose ELF architecture differs from the requested target.

```sh
export RUNME_TARGET_PLATFORM=linux
export RUNME_TARGET_ARCH=x64
export RUNME_RUNNER_BINARY=/absolute/path/to/runme-linux-amd64 # optional
pnpm package:desktop
```

The release directory contains `Runme-linux-x64/` and a versioned
`runme-desktop-linux-x64-<commit>.tar.gz`, checksum file, and JSON manifest.
Uncommitted source adds a `-dirty` suffix. The manifest records the full commit,
Electron version, target, and whether the runner is included. Ship the entire
archive; the executable depends on its bundled resources. Publish only these
three artifacts to a versioned GCS prefix, never the checkout or profile.

In the executor image, install Xvfb and Electron's Linux shared libraries
(including GTK, NSS, and GBM). Run as a non-root user with a working Chromium
sandbox. Extract the archive to the PVC, then launch:

```sh
export RUNME_DESKTOP_DATA_DIR=/workspace/runme/profile
export RUNME_GOOGLE_SERVICE_ACCOUNT=runme@YOUR_PROJECT.iam.gserviceaccount.com
/workspace/runme/Runme-linux-x64/start-headless.sh
```

The launcher uses Electron's bundled Node runtime to start Xvfb on an available
display, launch hidden Electron, and forward termination to the app before
stopping Xvfb. It reuses `DISPLAY` when already set. This does not install a
separate Node runtime, Chrome, agent-browser daemon, or global browser flags.
The MCP bridge supplies the integration with Chromium; agent-browser remains
an alternative for UI automation, not a dependency for notebook tools.

Before rolling out to agents, smoke-test the Linux archive in the actual
executor image: discover tools, create/edit/reopen a local notebook across a
restart, read/write a shared Drive notebook, refresh credentials after expiry,
and check denied IAM/Drive permissions fail without interactive fallback.
The local test suite covers policy, exchange, expiry, disconnect, transport,
and registry parity; it cannot certify the pod's IAM, Drive ACLs, or sandbox.
