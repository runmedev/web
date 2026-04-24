# Agentic Search And Codex

## Purpose

Runme Web now has a coherent path for Codex-style agentic search over notebook
context and, increasingly, repository or document corpora made available to the
browser runtime.

## Harness adapters

Current harness adapters:

- `responses-direct`,
- `codex`,
- `codex-wasm`.

## Intended interpretation

- `responses-direct`: direct Responses-based assistant path,
- `codex`: backend Codex app-server path,
- `codex-wasm`: browser-hosted Codex runtime with browser service hooks.

## Why `codex-wasm` matters

This is the most relevant adapter for agentic search inside the web app because
it can use browser-provided capabilities such as notebook APIs, OPFS, and other
host bridges without requiring the full desktop Codex environment.

## Configure the `codex-wasm` harness

Use the App Console to make the browser-hosted Codex harness active:

```js
app.harness.update("browser-codex", "", "codex-wasm")
app.harness.setDefault("browser-codex")
app.harness.getDefault()
app.harness.getActiveChatkitUrl()
```

Important details:

- `codex-wasm` intentionally uses an empty harness base URL.
- The active ChatKit route for this adapter resolves to
  `/codex/wasm/chatkit`.
- Do not point `codex-wasm` at the Runme runner websocket port. The runner is
  still only for notebook cell execution.

## Set the OpenAI API key

The browser-hosted Codex WASM app-server reuses the Responses Direct OpenAI
configuration. Set the key before opening the Codex chat flow:

```js
app.responsesDirect.setAPIKey("sk-...")
app.responsesDirect.get()
```

Equivalent shorthand:

```js
credentials.openai.setAPIKey("sk-...")
```

If the key is missing, the Logs pane should show a `chatkit.codex_wasm` error.

## Codex projects

A Codex project is a named local configuration record that Runme uses as the
default source of settings when it creates or resumes Codex threads.

In practice, a project carries the common thread context for a workspace, such
as:

- the project name,
- the current working directory,
- the default model,
- the sandbox policy,
- the approval policy,
- the agent personality.

Project selection matters because new threads inherit their defaults from the
selected project.

For non-WASM Codex transports, the project `cwd` is sent as part of thread
defaults. For `codex-wasm`, Runme still stores `cwd` on the project, but the
browser app-server is not given that value as a filesystem cwd.

## Codex project fields

Every configured project has these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique project identifier. This is what `setDefault(projectId)` expects. |
| `name` | yes | Human-readable project name shown in the UI and App Console output. |
| `cwd` | yes | Project working directory. This is used as part of project identity and thread scoping. |
| `model` | yes | Default model to use when starting or resuming Codex threads. |
| `sandboxPolicy` | yes | Sandbox mode for Codex execution, for example `workspace-write`. |
| `approvalPolicy` | yes | Approval behavior for Codex actions, for example `never`. |
| `personality` | yes | Agent style. Allowed values normalize to `none`, `friendly`, or `pragmatic`. |
| `writableRoots` | optional | Additional writable paths associated with the project. |
| `workspaceUri` | optional | Workspace URI metadata associated with the project. |
| `notebookUri` | optional | Notebook URI metadata associated with the project. |

Important details:

- The App Console `create(...)` helper currently takes the six required fields:
  `name`, `cwd`, `model`, `sandboxPolicy`, `approvalPolicy`, `personality`.
- `id` is generated automatically.
- The default personality is effectively `pragmatic`. Passing `default` is
  normalized to `pragmatic`.
- `cwd` must be non-empty. `""` is rejected.

## App Console project commands

Useful commands:

```js
app.codex.project.list()
app.codex.project.create(name, cwd, model, sandboxPolicy, approvalPolicy, personality)
app.codex.project.update(projectId, patch)
app.codex.project.delete(projectId)
app.codex.project.getDefault()
app.codex.project.setDefault(projectId)
```

## Create a project

Create a project for the current repo:

```js
app.codex.project.create(
  "Runme Web",
  "/Users/jlewi/code/runmecodex/web",
  "gpt-5.4",
  "workspace-write",
  "never",
  "pragmatic",
)
```

Create a browser-oriented project with a relative cwd:

```js
app.codex.project.create(
  "Codex Walkthrough",
  ".",
  "gpt-5",
  "workspace-write",
  "never",
  "default",
)
```

## List projects

`app.codex.project.list()` returns one line per project in this format:

```text
<projectId>: <name> (<cwd>, model=<model>, sandbox=<sandboxPolicy>, approval=<approvalPolicy>)
```

Example:

```js
app.codex.project.list()
```

Possible output:

```text
project-1: Runme Web (/Users/jlewi/code/runmecodex/web, model=gpt-5.4, sandbox=workspace-write, approval=never) (default)
project-2: Codex Walkthrough (., model=gpt-5, sandbox=workspace-write, approval=never)
```

## Get the `projectId` from the project name

The simplest way is to list projects and parse the line that matches the name.

```js
const projectName = "Codex Walkthrough";
const projectLines = String(app.codex.project.list())
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

let projectId = null;
for (const line of projectLines) {
  const match = line.match(/^([^:]+):\s*(.+?)\s+\(/);
  if (!match) {
    continue;
  }
  const [, id, name] = match;
  if (name === projectName) {
    projectId = id;
    break;
  }
}

console.log({ projectId });
```

If project names are not unique, match on both name and `cwd`:

```js
const projectName = "Codex Walkthrough";
const projectCwd = ".";
const projectLines = String(app.codex.project.list())
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

let projectId = null;
for (const line of projectLines) {
  const match = line.match(/^([^:]+):\s*(.+?)\s+\((.+?),\s*model=/);
  if (!match) {
    continue;
  }
  const [, id, name, cwd] = match;
  if (name === projectName && cwd === projectCwd) {
    projectId = id;
    break;
  }
}

console.log({ projectId });
```

## Create a project and set it as default

This pattern creates the project if needed, resolves the `projectId`, and then
marks it as default:

```js
const projectName = "Codex Walkthrough";
const projectCwd = ".";
const projectModel = "gpt-5";
const projectSandboxPolicy = "workspace-write";
const projectApprovalPolicy = "never";
const projectPersonality = "default";

const projectLines = String(app.codex.project.list())
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

let projectId = null;
for (const line of projectLines) {
  const match = line.match(/^([^:]+):\s*(.+?)\s+\((.+?),\s*model=/);
  if (!match) {
    continue;
  }
  const [, id, name, cwd] = match;
  if (name === projectName && cwd === projectCwd) {
    projectId = id;
    break;
  }
}

let projectCreateResult = "existing";
if (!projectId) {
  projectCreateResult = String(
    app.codex.project.create(
      projectName,
      projectCwd,
      projectModel,
      projectSandboxPolicy,
      projectApprovalPolicy,
      projectPersonality,
    ),
  );
  const match = projectCreateResult.match(/\(([^)]+)\)$/);
  projectId = match?.[1] ?? null;
}

if (!projectId) {
  throw new Error(`Could not resolve codex project id from: ${projectCreateResult}`);
}

console.log(app.codex.project.setDefault(projectId));
console.log(app.codex.project.getDefault());
```

## Update a project

You can patch a configured project by `projectId`:

```js
app.codex.project.update("project-1", {
  model: "gpt-5-mini",
  approvalPolicy: "on-request",
})
```

## Delete a project

```js
app.codex.project.delete("project-1")
```

## Fetch the browser app-server logs

For the WASM harness, the app-server runs inside the browser worker. The most
useful log surface is the local Codex turn journal:

```js
const turns = await codex.turns.list()
console.log(turns)

const [latest] = turns
if (latest) {
  console.log(
    await codex.turns.getEvents(latest.turnId, {
      sessionId: latest.sessionId,
    }),
  )
}
```

Use the bottom `Logs` pane for runtime failures and warnings. For `codex-wasm`,
look first for `chatkit.codex_wasm`.

## High-value facts for Codex

- When a user asks about "agentic search," assume they are usually talking
  about the Codex-backed harnesses, not plain ChatKit UI.
- Repository-backed or docs-backed search depends on what the active harness and
  runtime expose. Do not assume desktop Codex parity.
- For `codex-wasm`, the OpenAI API key comes from `app.responsesDirect`, not
  from browser OIDC session state.
- For `codex-wasm`, app-server diagnostics come from the browser journal and
  Logs pane rather than `/codex/app-server/ws` server logs.
