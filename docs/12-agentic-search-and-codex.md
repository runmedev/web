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

## Harness commands

```js
app.harness.get()
app.harness.update("local-codex", "http://localhost:9977", "codex")
app.harness.update("browser-codex", "", "codex-wasm")
app.harness.setDefault("browser-codex")
app.harness.getActiveChatkitUrl()
```

When using codex the URI should be the baseURL of the runner that is proxying connections
to Codex.

## Codex project commands

```js
app.codex.project.list()
app.codex.project.create(name, cwd, model, sandboxPolicy, approvalPolicy, personality)
app.codex.project.setDefault(projectId)
```

## High-value facts for Codex

- When a user asks about "agentic search," assume they are usually talking
  about the Codex-backed harnesses, not plain ChatKit UI.
- Repository-backed or docs-backed search depends on what the active harness and
  runtime expose. Do not assume desktop Codex parity.
