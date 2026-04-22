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

## Codex project commands

```js
app.codex.project.list()
app.codex.project.create(name, cwd, model, sandboxPolicy, approvalPolicy, personality)
app.codex.project.setDefault(projectId)
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
