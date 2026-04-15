# 20260414 Codex WASM Harness

## Status

Draft proposal.

## Summary

Add a third browser harness adapter, `codex-wasm`, alongside
`responses-direct` and `codex`.

`codex-wasm` runs the Codex browser harness inside the web app via WASM, uses
Codex code mode, and binds Codex tool execution to the existing Runme browser
sandbox kernel. For v0, the goal is parity with the current browser-direct
Responses harness for code execution and other browser-owned tools, without
bringing over heavier Codex runtime features such as Recorder.

## Problem

Today we have two harness shapes:

- `responses-direct`: a browser-local turn loop in
  [responsesDirectChatkitFetch.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/responsesDirectChatkitFetch.ts)
  that talks directly to the Responses API and executes browser tools locally.
- `codex`: a remote Codex app-server path that depends on `/codex/chatkit`,
  `/codex/ws`, and `/codex/app-server/ws`.

The `responses-direct` path gave us a fast way to ship browser-native tool
execution, but it is still our own small harness. As we add more tools and more
agent behaviors, continuing to grow that custom loop in this repo is the wrong
direction. We want to build on the Codex harness instead.

Separately, the Codex branch in `~/code/codex` now contains a browser harness
prototype under `codex-rs/wasm-harness`. That branch establishes the right seam
for embedding a Codex harness in a downstream browser app, but it still needs a
few integration-oriented changes before Runme can use it as its primary browser
harness.

## Background

Runme's ChatKit integration already routes through a harness-selected custom
`fetch` implementation.

At a high level:

1. `ChatKitPanel` builds an authorized fetch wrapper.
2. That wrapper delegates to a harness-specific `baseFetch`.
3. The selected `baseFetch` is responsible for handling ChatKit protocol
   requests and returning normal `Response` objects, including SSE streams for
   turn output.

Today the main browser-visible fetch implementations are:

- `createResponsesDirectChatkitFetch(...)` for the browser-local
  `responses-direct` harness,
- `createCodexChatkitFetch(...)` for the remote `codex` harness.

This is why the `codex-wasm` design introduces
`createCodexWasmChatkitFetch(...)` rather than a new ChatKit integration
mechanism. The existing integration seam is already "ChatKit speaks `fetch`,
and the web app chooses which harness-backed fetch handler receives the
request."

For `codex-wasm`, that means:

- ChatKit still uses the same request/response path,
- the app still selects a harness-specific fetch implementation,
- but the selected handler runs the Codex WASM harness locally in the browser
  instead of proxying to the remote app-server stack.

### Current Browser API

The current Codex WASM implementation exposes a browser-facing API through
`BrowserCodex. It wraps
`codex-core::CodexThread` and calls `submit(Op::UserTurn { ... })`.

Today the browser API works like this:

- JavaScript creates a harness instance with `new BrowserCodex(apiKey)`.
- JavaScript may later update the API key with `set_api_key(...)`.
- JavaScript registers one host-side code-mode callback with
  `set_code_executor(...)`.
- JavaScript starts a turn with `submit_turn(prompt, on_event)`.
- Rust lazily creates a real Codex session/thread if needed, emits a
  `SessionConfigured` event, submits `Op::UserTurn`, then forwards real Codex
  `Event` objects back to JavaScript by invoking the supplied `on_event`
  callback.
- `submit_turn(...)` resolves with the submission id once the matching turn
  reaches `TurnComplete`, `TurnAborted`, or `Error`.

The important consequence is that the browser-facing shim is now thin, but it
is still a shim:

- JavaScript does not currently pass a full thread/session object into Rust.
- JavaScript passes the prompt string for the new turn.
- JavaScript passes a callback for streamed Codex protocol events.
- JavaScript configures browser-specific host state such as the API key and code
  executor out of band.

The code executor callback also has a richer contract than the older
`exec_js(code: string)` prototype. The Rust side serializes a request that
includes:

- `source` for the code to run,
- `stored_values` for code-mode state continuity,
- `enabled_tools` describing code-mode capabilities,

and expects a response containing:

- `output`,
- updated `stored_values`,
- optional `error_text`.

This is the API surface we should assume for v0.

TODO: revisit this section as the Codex WASM API continues to settle. The crate
now uses the true Codex submit path, but the browser-facing `BrowserCodex`
wrapper may still evolve as upstream Codex exposes a more native browser/session
boundary.

### Current Codex-to-ChatKit Mapping

The existing remote `codex` harness path already contains an event translation
layer that converts Codex-side activity into ChatKit stream events.

Today that logic lives primarily in
[codexConversationController.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexConversationController.ts).
That controller:

- receives Codex-side notifications from the current app-server/proxy path,
- tracks thread and turn state,
- emits ChatKit stream events such as:
  - `thread.item.added`
  - `thread.item.updated`
  - `assistant_message.content_part.text_delta`
  - `thread.item.done`
  - `response.completed`
  - `aisre.chatkit.state`

So we do already have a working "Codex events -> ChatKit events" adapter in the
repo.

However, the current implementation is tightly coupled to the remote Codex
app-server protocol and its notification shapes. Those notifications are derived
from upstream Codex `EventMsg`, but they are not the same wire shape.

In the WASM case, the browser callback now receives real Codex `Event` /
`EventMsg` protocol objects rather than app-server `thread/*`, `turn/*`, and
`item/*` notifications. That means the exact code in
`codexConversationController.ts` is not directly reusable as-is.

What we should reuse is:

- the existing ChatKit event vocabulary,
- the existing mapping patterns for assistant-message lifecycle and state
  updates,
- the current tests and fixtures that validate those emitted ChatKit events.

What we should likely refactor is:

- extracting the generic "normalized Codex lifecycle -> ChatKit stream events"
  logic into a smaller shared adapter,
- with one input adapter for remote app-server notifications and another for
  raw Codex `Event` / `EventMsg` from WASM.

## Goals

- Add `codex-wasm` as a first-class harness adapter in Runme web.
- Run Codex in the browser through the WASM harness rather than through the
  remote `codex` websocket/app-server stack.
- Use Codex code mode and wire its code-execution tool to
  [codeModeExecutor.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codeModeExecutor.ts)
  in sandbox mode.
- Reuse the existing ChatKit thread/item streaming shape already used by
  `responses-direct`.
- Keep v0 narrow: parity with the current browser harness for local tool
  execution, not full parity with every Codex desktop or app-server feature.

## Non-Goals

- Porting full `codex-core` to `wasm32` in this design.
- Supporting Recorder, memories, sub-agents, or the full app-server protocol in
  v0.
- Replacing the existing `codex` adapter immediately.
- Redesigning the notebook tool contract in this document.

## Current State

### Runme web

The current harness split is hard-coded around two adapters:

- [harnessManager.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/harnessManager.ts)
  defines `HarnessAdapter = "responses-direct" | "codex"`.
- [ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx)
  selects either `createResponsesDirectChatkitFetch(...)` or
  `createCodexChatkitFetch(...)`.
- `responses-direct` already has a browser-local thread store, direct Responses
  API streaming, and local tool execution.
- Code execution already has a clean browser host seam in
  [codeModeExecutor.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codeModeExecutor.ts),
  backed by the sandbox iframe kernel in
  [sandboxJsKernel.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/sandboxJsKernel.ts).

This is good news for `codex-wasm`: most of the host-side capability we need is
already present.

### Codex branch

The Codex branch has a new crate:

- [codex-rs/wasm-harness/Cargo.toml](/Users/jlewi/code/codex/codex-rs/wasm-harness/Cargo.toml)
- [codex-rs/wasm-harness/README.md](/Users/jlewi/code/codex/codex-rs/wasm-harness/README.md)
- [codex-rs/wasm-harness/src/harness.rs](/Users/jlewi/code/codex/codex-rs/wasm-harness/src/harness.rs)
- [codex-rs/wasm-harness/src/browser.rs](/Users/jlewi/code/codex/codex-rs/wasm-harness/src/browser.rs)
- [codex-rs/wasm-harness/src/responses.rs](/Users/jlewi/code/codex/codex-rs/wasm-harness/src/responses.rs)

The important architectural point has changed from the earlier prototype. The
active downstream boundary is now the browser-facing `BrowserCodex` wrapper in
`src/browser.rs`, and that wrapper drives a real `codex-core::CodexThread`.

The current exported surface is effectively:

- `BrowserCodex` as the `wasm_bindgen` entrypoint,
- `submit_turn(prompt, on_event)` to call `CodexThread::submit(Op::UserTurn {
  ... })`,
- `set_code_executor(...)` to inject the host code-mode runtime callback,
- real upstream Codex `Event` / `EventMsg` objects streamed back to JavaScript.

There are still older Rust files in the crate such as `src/harness.rs`, but
they are no longer the active embedding surface for the browser integration.
Runme should plan against `BrowserCodex` and the real Codex protocol event
stream, not the earlier `EmbeddedHarness` path.

## Gaps In The Current Codex WASM Browser Wrapper

The current browser wrapper is close enough to plan against, but not yet the exact
shape Runme needs.

### 1. Browser transport is API-key oriented

`BrowserCodex` currently owns a direct browser `fetch` to
`https://api.openai.com/v1/responses` and takes a raw API key.

For v0, we explicitly accept that limitation. A user must supply an API key to
use the `codex-wasm` ChatKit harness.

Runme already has a user-facing browser API for this through the existing
Responses-direct configuration path:

- `app.responsesDirect.setAPIKey(...)`
- `credentials.openai.setAPIKey(...)`

Both feed the persisted `responsesDirectConfigManager`, which already stores the
OpenAI API key in browser localStorage for the current direct Responses
integration.

For v0, `codex-wasm` should reuse that same stored key rather than introducing a
second Codex-specific credential flow. In practice that means the Runme-side
`codex-wasm` loader/session code should read
`responsesDirectConfigManager.getSnapshot().apiKey` and pass it into
`new BrowserCodex(apiKey)` / `set_api_key(...)`.

This is not the long-term browser auth model we want, but it is acceptable for
the first integration because it lets us prove the harness architecture without
blocking on upstream transport abstraction work.

### 2. V0 does not require hosted Responses tools

The current browser harness path is centered on Codex code mode and a
browser-injected code executor. That is sufficient for the v0 Runme goal.

For this proposal, we make the v0 decision explicitly: `codex-wasm` parity only
includes browser-executed tools. We do not require hosted Responses tools such
as `file_search`.

That is consistent with the broader Runme direction. We are moving away from
`file_search` for notebook workflows because it does not work well enough for
notebooks. The intended search direction is the Drive-native agentic search path
described in
[20260403_drive_agentic_search.md](/Users/jlewi/code/runmecodex/web/docs-dev/design/20260403_drive_agentic_search.md),
which is one of the motivations for adopting the Codex harness rather than
continuing to extend the current lightweight browser loop.

### 3. Browser facade is code-mode oriented

The current WASM boundary exposes one injected host capability: the code-mode
runtime callback registered through `set_code_executor(...)`.

That is actually aligned with the current Runme browser direction. Per
[20260331_code_mode.md](/Users/jlewi/code/runmecodex/web/docs-dev/design/20260331_code_mode.md)
and PR #160, the browser harness is moving to a single code-mode tool design:

- one model-facing tool (`ExecuteCode` in Runme terms, `exec_js` in the current
  Codex WASM prototype),
- with richer host functionality made available inside the executed JavaScript
  environment rather than as separate model-facing tools.

So the real distinction here is not "many browser tools vs one browser tool."
It is:

- one model-facing tool, and
- a richer host environment behind that tool.

For Runme, that richer host environment today is the sandbox AppKernel surface
exposed through `runme`, `notebooks`, and `help`, with future expansion likely
to come from browser-side APIs such as Drive-native agentic search rather than a
return to many notebook CRUD tools.

For v0, `codex-wasm` should follow that same single-tool design. We do not need
additional model-facing browser tools to unblock v0 as long as the WASM harness
can bind its code-mode execution path to Runme's existing `CodeModeExecutor`.

### 4. Browser services are still degraded relative to desktop Codex

The README is explicit that this is still a minimal browser port, not full
desktop Codex.

What is true today:

- it uses the real `CodexThread` turn path,
- it emits real upstream Codex protocol events,
- code mode runs through one injected browser callback,
- native shell, PTY, MCP, plugin runtime, and filesystem-backed persistence are
  not available in the browser prototype.

That is acceptable for v0. Our goal here is not "full Codex desktop in the
browser." Our goal is "stop growing a custom TypeScript harness, and switch the
browser harness boundary to the Codex implementation."

### 5. Session lifetime is still browser-wrapper specific

Today `BrowserCodex.submit_turn(...)` resets its cached session after the turn
finishes, so the browser wrapper currently behaves more like "fresh Codex
session per submission" than a long-lived in-page thread.

That does not block the design doc, but it is important to call out because
Runme's current browser harnesses preserve local thread continuity. We need to
decide whether v0 accepts this wrapper behavior or whether upstream Codex needs
to preserve the session across turns.

## Proposal

Add a new harness adapter, `codex-wasm`, which behaves like this:

1. ChatKit selects a local `fetch` implementation,
   `createCodexWasmChatkitFetch(...)`.
2. That fetch implementation keeps the same local thread/item model used by
   `responses-direct`.
3. Instead of building the turn loop in TypeScript, it instantiates the Codex
   WASM harness and submits the prompt to it.
4. The Codex WASM harness talks directly to the Responses API using the current
   Codex browser facade and an OpenAI API key supplied through Runme's existing
   `responsesDirectConfigManager` path.
5. When Codex emits a code-execution tool call, the Codex harness invokes the
   Runme-provided tool handler for that tool.
6. That Runme-provided tool handler executes the request via
   `CodeModeExecutor.execute({ code, source: "codex" })` using the existing
   sandbox-mode executor instance.
7. The WASM harness emits Codex-shaped events; the local fetch adapter
   translates them into ChatKit stream events and thread items.

In short: `responses-direct` stays the UI transport pattern, but the actual turn
loop moves into the Codex WASM crate.

## Why A Third Harness

We should keep all three adapters for now:

- `responses-direct`: current stable browser harness.
- `codex`: remote websocket/app-server Codex integration.
- `codex-wasm`: browser-local Codex harness.

`codex-wasm` is not a drop-in replacement for the current `codex` adapter,
because it intentionally avoids the remote app-server features. It is also not
the same as `responses-direct`, because the harness loop and prompting live in
Codex rather than in Runme TypeScript.

## Detailed Design

### Harness routing

Update
[harnessManager.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/harnessManager.ts)
to support:

```ts
type HarnessAdapter = "responses-direct" | "codex" | "codex-wasm";
```

`codex-wasm` should resolve to a local ChatKit route, for example:

```ts
"/codex/wasm/chatkit"
```

Like `responses-direct`, this route only exists as a logical endpoint consumed
by a browser `fetch` interceptor. It does not require a backend handler.

`baseUrl` should be optional for `codex-wasm`, because the harness runs in the
page and should use the same browser auth/config path as `responses-direct`.

### ChatKitPanel changes

[ChatKitPanel.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.tsx)
should select among three local/remote fetch implementations:

- `responses-direct` -> `createResponsesDirectChatkitFetch(...)`
- `codex` -> `createCodexChatkitFetch(...)`
- `codex-wasm` -> `createCodexWasmChatkitFetch(...)`

`codex-wasm` should behave like `responses-direct` in these respects:

- no `/codex/ws` bridge,
- no `/codex/app-server/ws` proxy bootstrap,
- no codex thread-history bootstrap through the remote app server.

Instead, thread state remains browser-local in the `codex-wasm` fetch adapter.

### Browser host services

We should introduce a Runme-side browser host wrapper around the Codex crate.
The exact file names are flexible, but the responsibilities are not:

- `codexWasmHarnessLoader.ts`
  - live under committed app source in `web/app/src/...`,
  - resolve generated artifact URLs with `resolveAppUrl(...)`,
  - lazy-load and initialize the generated WASM module,
  - cache a singleton module instance.
- `codexWasmSession.ts`
  - create or manage a harness instance,
  - inject transport and tool callbacks,
  - expose `submitTurn(...)`.
- `codexWasmChatkitFetch.ts`
  - keep the browser-local ChatKit thread model,
  - translate Codex WASM events into ChatKit SSE events.

### Proposed Runme integration

Given the current `BrowserCodex` API, the Runme-side integration should work in
four layers:

1. **WASM loading**
   - use a small handwritten Runme loader in `src/` rather than importing
     Cargo output directly,
   - resolve the generated artifact URLs from the app base path,
   - lazily load and initialize the generated `codex_wasm_harness.js`
     wrapper and companion `.wasm`,
   - create a `BrowserCodex` instance,
   - configure `set_api_key(...)` and `set_code_executor(...)`.

2. **Host tool binding**
   - register a Runme host callback for the Codex code-execution tool,
   - implement that callback with `CodeModeExecutor` in sandbox mode,
   - keep tool implementation ownership in Runme while leaving tool-call
     orchestration in Codex.

3. **Event translation**
   - call `submit_turn(prompt, onEvent)`,
   - receive streamed upstream Codex `Event` objects from WASM,
   - translate those `Event` / `EventMsg` values into ChatKit stream events.

4. **ChatKit fetch integration**
   - wrap the above in `createCodexWasmChatkitFetch(...)`,
   - return normal `Response` objects and SSE payloads to ChatKit,
   - keep browser-local thread state and `previousResponseId` continuity.

In practice, `codexWasmChatkitFetch.ts` is the integration point that ties all
four layers together.

### Reusing the current Codex adapter

We should reuse the existing Codex adapter patterns, but probably not the
current controller implementation wholesale.

The existing remote `codex` path proves that we already know how to:

- represent assistant-message lifecycle in ChatKit,
- emit `aisre.chatkit.state` updates,
- handle text deltas and final message completion,
- synthesize end-of-turn markers and response completion events.

That makes the current remote Codex adapter the right reference
implementation for `codex-wasm`.

The likely reuse strategy is:

- keep using the same ChatKit event shapes and test expectations,
- extract shared helpers for:
  - state emission,
  - assistant item creation,
  - delta application,
  - completion/end-of-turn synthesis,
- add a new mapper from raw Codex `Event` / `EventMsg` to those shared helpers.

The current remote controller is still useful as a source of truth for the
ChatKit-side contract, even if the WASM path ends up with a smaller and cleaner
adapter module.

### Transport seam

For v0, we will not block on a custom transport seam. `codex-wasm` will use the
current `BrowserCodex` model:

- direct browser `fetch` to the Responses API,
- user-supplied API key,
- Codex-owned request construction and response parsing.

That keeps the first integration simple and minimizes upstream changes required
before Runme can try the harness in-browser.

The recommended follow-on direction for the Codex crate is still to support a
host-provided Responses transport, but that is explicitly post-v0 work.

### Instruction injection

The instruction path needs to be updated to match the new Codex submit-based
browser wrapper.

Today `BrowserCodex` builds a real Codex config/thread internally and submits
`Op::UserTurn`, but it does not yet expose an explicit Runme-facing API for
passing extra user/developer instructions into that session configuration.

So the v0 design requirement is:

- add or confirm a `BrowserCodex` configuration seam for Runme-specific
  instructions,
- use that seam to describe the browser runtime available behind the single
  code-mode tool.

The injected guidance should cover at least:

- the model-facing tool is code mode (`ExecuteCode` in Runme terms),
- executed JavaScript runs inside the Runme browser sandbox,
- the runtime inside executed code exposes `runme`, `notebooks`, and `help`,
- browser-only constraints or workflow guidance that the model needs in order to
  use those helpers correctly.

This keeps the behavior aligned with the current `responses-direct` design,
which already relies on detailed browser-specific instructions in
[responsesDirectChatkitFetch.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/responsesDirectChatkitFetch.ts).

TODO: revisit this section once the Codex WASM browser API settles. The wrapper
now uses the true Codex submit path, but the exact configuration surface for
instruction injection may still change as upstream Codex removes remaining
browser-specific shims and exposes a more native embedded configuration model.

### Tool execution

For v0, `codex-wasm` should wire Codex code mode to the existing sandbox code
executor:

```ts
createCodeModeExecutor({
  mode: "sandbox",
  resolveNotebook,
  listNotebooks,
})
```

The first mapped tool should be the Codex-side code-execution tool. Today the
browser wrapper exposes that through the code-mode runtime callback rather than
through a separate Runme-defined function tool. That is acceptable for v0 as an
internal Codex detail.

The important requirement is that Codex code-mode execution in the WASM harness
routes to the same sandbox runtime already used by Runme code mode.

Ownership should be explicit:

- the Codex WASM harness owns the turn loop and decides when a tool call is
  needed,
- the Codex WASM harness invokes the registered browser code executor,
- the Runme host implementation of that executor uses
  `CodeModeExecutor.execute({ code, source: "codex" })` to run the code inside
  the browser sandbox,
- the host callback maps Runme's `{ output }` result back into the JSON shape
  expected by `BrowserCodeModeRuntime`, including `stored_values` and optional
  `error_text`.

That gives us:

- the existing AppKernel helper surface,
- notebook APIs,
- existing timeouts and output limits,
- the existing browser sandbox boundary.

### Event mapping

The Codex WASM harness now emits real upstream Codex `Event` objects. Those
wrap `EventMsg` variants such as:

- `SessionConfigured`
- `TurnStarted`
- `AgentMessageDelta`
- `AgentMessage`
- code-mode and tool-call lifecycle events
- `TurnComplete`
- `TurnAborted`
- `Error`

`codexWasmChatkitFetch.ts` should translate those raw Codex events into the
same ChatKit stream shapes already used by `responses-direct`:

- thread creation and thread state updates,
- assistant message placeholder creation,
- assistant text deltas,
- client tool call items,
- end-of-turn items.

This is another reason to keep the local `fetch` shim: ChatKit already expects
those stream events, and the existing Codex/Responses adapters give us a proven
template for the target shape even though the WASM input stream is different.

### Thread persistence

For v0, thread persistence should remain browser-local, just like
`responses-direct`.

We do not need to integrate Codex Recorder or any stateful app-server storage in
this phase. A simple local in-memory thread store is enough to validate the
browser harness architecture.

## V0 Scope

V0 should include:

- new harness type `codex-wasm`,
- browser-local Codex harness execution through WASM,
- API-key-based authentication for the `codex-wasm` harness,
- Codex code mode tool wired to the sandbox kernel,
- ChatKit streaming and thread behavior equivalent to `responses-direct`,
- direct Responses API calls through the current Codex browser facade.

V0 should explicitly defer:

- Recorder,
- remote thread history,
- app-server protocol support,
- sub-agents and long-running task controls,
- any feature that requires full `codex-core` parity rather than browser harness
  parity.

## Concrete Changes In Runme Web

### Routing and config

- Update
  [harnessManager.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/harnessManager.ts)
  for `codex-wasm`.
- Update
  [appJsGlobals.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/appJsGlobals.ts)
  so `app.harness.update(..., "codex-wasm")` works.
- Reuse the existing OpenAI API key setters exposed through
  `app.responsesDirect.setAPIKey(...)` and `credentials.openai.setAPIKey(...)`
  instead of adding a new Codex-specific API key API for v0.
- Add tests in
  [harnessManager.test.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/harnessManager.test.ts)
  and
  [ChatKitPanel.test.tsx](/Users/jlewi/code/runmecodex/web/app/src/components/ChatKit/ChatKitPanel.test.tsx)
  for the new adapter.

### Runtime

- Add `codexWasmHarnessLoader.ts`.
- Add `codexWasmChatkitFetch.ts`.
- Potentially add `codexWasmHost.ts` or `codexWasmSession.ts` to keep the
  WASM-specific state out of `ChatKitPanel.tsx`.
- Read the v0 API key from `responsesDirectConfigManager.getSnapshot().apiKey`
  and pass it through to `BrowserCodex`.
- Reuse
  [codeModeExecutor.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codeModeExecutor.ts)
  and
  [sandboxJsKernel.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/sandboxJsKernel.ts)
  unchanged except for any small adapter glue.

### Dependency management

For v0, we should consume the Codex WASM harness from source via a **git
dependency on the Codex branch** and compile it in the `runmedev/web` repo
build flow rather than reimplementing its logic locally.

This fits the current Codex crate structure. `codex-rs/wasm-harness` is part of
the Codex Rust workspace and uses workspace-managed metadata and dependency
resolution. By pulling it in as a git dependency, Cargo resolves the crate in
the context of the original Codex workspace instead of forcing us to vendor the
whole workspace into the Runme repo.

The expected build shape becomes:

1. Add a small Runme-side Rust wrapper or helper workspace in `web/wasm/`.
2. Declare a pinned git dependency on `codex-wasm-harness` from the Codex repo
   and branch/revision.
3. Run `cargo build --target wasm32-unknown-unknown`.
4. Run `wasm-bindgen --target web ...`.
5. Stage the generated JS/WASM output into the app's static asset directory.
6. Load those generated assets from a small handwritten loader in the Vite app.

This changes a few things in a useful way:

- packaging is now reproducible against a pinned Codex revision,
- we no longer need to make `codex-wasm-harness` standalone before trying the
  integration,
- Runme does not need to vendor Codex Rust sources directly,
- upstream API stability matters more because Runme will be pinned to and built
  against a real Codex branch revision.

For local development we may still want an override path to a local Codex
checkout, but the documented v0 default should be a pinned git dependency.

### Build layout

With the git dependency decision made, the recommended Runme-side layout is:

- `web/wasm/`
  - small Rust helper workspace or wrapper crate,
  - `Cargo.toml` with git dependency on `codex-wasm-harness`,
  - build script that produces browser artifacts.
- generated output staged into the app's existing Vite static asset directory:
  - `web/app/assets/generated/codex-wasm/`
  - for example:
    - `web/app/assets/generated/codex-wasm/codex_wasm_harness.js`
    - `web/app/assets/generated/codex-wasm/codex_wasm_harness_bg.wasm`
- handwritten integration code committed under app source:
  - `web/app/src/lib/runtime/codexWasmHarnessLoader.ts`
  - `web/app/src/lib/runtime/codexWasmSession.ts`
  - `web/app/src/lib/runtime/codexWasmChatkitFetch.ts`

This matches the current app's Vite setup. The app already uses
`publicDir: "assets"` and serves files such as
`configs/app-configs.yaml` from that static asset tree.

The intended split is:

- generated `wasm-bindgen` artifacts are build outputs and should not be
  committed to git,
- handwritten Runme loader code lives in `src/` and is bundled with the app,
- the loader resolves the generated asset URLs with `resolveAppUrl(...)` and
  initializes the generated wrapper at runtime.

This is preferable to placing generated artifacts under `src/` because it keeps
generated code out of the Vite module graph while still using the repo's
existing static-asset serving path.

## Concrete Changes Needed In Codex

The current Codex branch is close, but we should make these upstream changes to
support Runme cleanly:

1. Keep the exported WASM/browser API stable enough for downstream consumption
   as a pinned git dependency.
2. Expose or stabilize a configuration seam for Runme-specific instructions in
   the real Codex session path.
3. Keep the current code-execution binding simple enough to wire into Runme's
   single-tool code-mode design.
4. Keep the raw `Event` / `EventMsg` surface stable enough for downstream UI
   adapters to translate it into ChatKit events.
5. Decide whether `BrowserCodex` should preserve a session across turns instead
   of resetting after each submission.

None of those changes require full `codex-core` in WASM. They are boundary
changes, not a runtime port.

## Phased Plan

### Phase 1: Boundary hardening in Codex

- Keep the exported WASM/browser API stable enough to consume from a pinned git
  revision.
- Stabilize the code executor request/response contract used by
  `BrowserCodeModeRuntime`.
- Add or confirm a configuration path for Runme-specific instructions.
- Keep v0 scoped to browser-executed tools; do not block on hosted Responses
  tools such as `file_search`.
- Decide whether the browser wrapper should preserve session continuity across
  turns.

### Phase 2: Runme adapter integration

- Add `codex-wasm` harness routing.
- Add the local ChatKit fetch shim backed by the Codex WASM harness.
- Wire the Codex browser code executor to `CodeModeExecutor` in sandbox mode.
- Add tests for adapter selection and tool execution.

### Phase 3: Cutover experiments

- Exercise notebook workflows under `codex-wasm`.
- Compare behavior with `responses-direct`.
- Decide whether `responses-direct` remains as a fallback or is eventually
  retired.

## Risks

- The current Codex WASM crate is still a prototype. If we integrate directly
  against demo-oriented APIs, we will create churn on both sides.
- Git-dependency consumption means upstream Codex API churn directly affects the
  Runme build until we pin and update revisions carefully.
- The WASM callback emits raw Codex `Event` / `EventMsg`, while the existing
  remote controller consumes app-server notifications derived from those
  events. A clean normalization layer is needed to avoid duplicating mapping
  logic.
- If `BrowserCodex` continues to reset session state after each turn, we may
  get behavior drift relative to the browser-local thread continuity that
  Runme's current harnesses expect.
- Prompt and event-shape differences between `responses-direct` and Codex may
  surface UX drift in ChatKit even when tool execution works.
- WASM packaging and asset loading can become more work than the harness logic
  itself if we do not settle the build artifact story early.

## Test Plan

Unit:

- `HarnessAdapter` accepts `codex-wasm`.
- `buildChatkitUrl(..., "codex-wasm")` resolves to the local browser route.
- `app.harness.update(..., "codex-wasm")` stores and formats correctly.

Integration:

- `ChatKitPanel` selects `createCodexWasmChatkitFetch(...)` for
  `codex-wasm`.
- A prompt under `codex-wasm` triggers a Codex WASM turn, streams assistant
  deltas, executes Codex code mode, and completes the turn.
- The browser code executor runs through `CodeModeExecutor` with
  `mode: "sandbox"` and `source: "codex"`.

Browser E2E:

- switch harness to `codex-wasm`,
- ask for a notebook inspection or mutation that requires code mode,
- verify the output and notebook-visible side effects match the current
  `responses-direct` experience for the same task,
- verify the API-key-only setup path is clear and functional.

## Open Questions

- Is API-key-only authentication for `codex-wasm` acceptable beyond local/dev
  usage, or should we treat it as strictly temporary from the outset?
- Should `codex-wasm` use browser-local thread persistence only, or should we
  persist threads in localStorage from day one?
- Should `BrowserCodex` preserve the underlying Codex session across turns, or
  is the current "fresh session per submission" wrapper behavior acceptable for
  the first integration?
- What is the exact instruction-injection API that Runme should target once the
  browser wrapper settles?
- What is the exact Runme-side Rust wrapper layout for building the git-pinned
  Codex WASM dependency and staging its generated assets into the web app?

## References

- User-referenced design doc:
  [Codex harness in browser Google doc](https://docs.google.com/document/d/1ukACcrfmLvJAuqR7ZR9EYVE5SyvXpnDMhfyqCSqnDn8/edit?tab=t.0#heading=h.74vvbahro6wf)
- Codex WASM harness README:
  [README.md](/Users/jlewi/code/codex/codex-rs/wasm-harness/README.md)
- Current browser-direct harness:
  [responsesDirectChatkitFetch.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/responsesDirectChatkitFetch.ts)
- Current code mode design:
  [20260331_code_mode.md](/Users/jlewi/code/runmecodex/web/docs-dev/design/20260331_code_mode.md)
