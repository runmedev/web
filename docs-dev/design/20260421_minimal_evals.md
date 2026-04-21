# 20260421 Minimal Evals For Codex-WASM Agentic Search

## Status

Draft proposal.

## Summary

We want a minimal eval harness for `codex-wasm` that can:

- submit a prompt such as `What is a runme runner?`
- run and observe the turn programmatically
- assert on intermediate behavior such as tool usage
- assert on end state such as notebook mutations or final text

The recommended design is:

1. run evals in a real headless browser runtime
2. avoid using the DOM as the test contract
3. reuse the same runtime libraries the UI already uses
4. drive those libraries from a TypeScript CLI using Playwright or CDP
5. assert primarily against:
   - app-server requests and notifications
   - notebook state snapshots
   - assistant output

This keeps the eval environment faithful to the browser-only `codex-wasm`
design while avoiding brittle UI automation.

## Context

The newer `codex-wasm` direction is defined in the design docs:

- `20260415_agentic_search.md`
- `20260417_codex_wasm_appserver.md`

Agentic search and other capabilities depend on various parameters
- prompts
- docs
- utility libraries

We need evals to systematically measure and improve these parameters.

## Background: How The UI Works Today

On the latest `main`, the UI now has two Codex-backed harnesses:

- `codex`: remote app-server over websocket
- `codex-wasm`: browser-local wasm app-server running behind the same higher-
  level client/controller flow

Both go through the same high-level path:

```text
ChatKit React UI
  -> authorized fetch wrapper
  -> createCodexChatkitFetch()
  -> CodexConversationController
  -> CodexAppServerClient
  -> transport = proxy or wasm
  -> app-server notifications
  -> CodexConversationController
  -> ChatKit SSE events
  -> ChatKit React UI
```

More concretely:

1. `ChatKitPanel` creates an authorized fetch wrapper.
2. That wrapper uses `createCodexChatkitFetch()` as `baseFetch` for the
   `codex` and `codex-wasm` adapters.
3. `createCodexChatkitFetch()` parses ChatKit-shaped request bodies such as
   `threads.list`, `threads.get`, and message-send requests.
4. For message-send requests, it calls
   `getCodexConversationController().streamUserMessage(...)`.
5. `ChatKitPanel` bootstraps the transport through `CodexAppServerClient`:
   - for `codex`, it calls `connectProxy(...)`
   - for `codex-wasm`, it calls `connectWasm(...)`
   - for `codex-wasm`, it also installs the browser code executor bridge
6. `CodexConversationController`:
   - ensures or creates the active thread
   - subscribes to app-server notifications through
     `CodexAppServerClient.subscribeNotifications(...)`
   - sends `thread/start` and `turn/start` through the unified app-server
     client
   - converts app-server notifications into ChatKit stream events
7. `createCodexChatkitFetch()` returns those ChatKit stream events as an SSE
   `Response`.

So the real control plane is already below ChatKit. ChatKit mostly issues
`fetch` requests; the fetch shim, conversation controller, and app-server
client do the substantive work.

## Goals

- Exercise the real `codex-wasm` runtime in a browser-faithful environment.
- Submit prompts and collect results from JS/TS, not from the UI.
- Support behavior assertions such as "did the agent use notebook mutation?"
- Support outcome assertions such as "did the notebook gain a cell containing
  `hello world`?"
- Keep the first version small enough to implement quickly.

## Non-Goals

- Do not make DOM rendering the primary contract.
- Do not require pixel/UI automation for pass/fail.
- Do not build a full general-purpose benchmark runner up front.
- Do not block on a bespoke search SDK; evals should work with the low-level
  agentic-search model described in the design docs.

## Question 1: Runtime Environment

### Recommendation

Use headless Chromium as the runtime environment, launched from a Node/TS
driver.

Playwright is the simplest way to do this from TypeScript, though a raw CDP
client would also work.

### Why Chromium

`codex-wasm` and the proposed agentic-search flow rely on browser features that
do not exist or are not trustworthy in pure Node-based test environments:

- Web Workers
- WebAssembly in a browser worker
- IndexedDB
- OPFS / browser-persistent storage
- browser `fetch`
- the existing Runme browser AppKernel integration

`jsdom` or a pure Vitest node environment will not be faithful enough.

### Why Headless Browser Instead Of DOM Automation

We need browser capabilities, not UI fidelity.

The right distinction is:

- `yes` to a real browser runtime
- `no` to using visible DOM elements as the control plane

The eval driver should call existing runtime interfaces with
`page.evaluate(...)` or CDP runtime evaluation, not click the ChatKit composer
and read rendered bubbles.

### Chrome vs Something Else

For v0, Chromium should be the default.

Reasons:

- it is the best-supported headless browser for modern storage/runtime APIs
- it matches the environment we are already implicitly designing for
- Playwright support is straightforward
- CDP access is first-class if we need lower-level debugging later

Firefox or WebKit can be follow-up compatibility targets, not the initial eval
runtime.

## Question 2: How To Invoke Prompts And Measure Responses

### Recommendation

Use the same libraries the UI already uses and bypass ChatKit itself.

The recommended eval seam is:

- `CodexConversationController` for prompt execution and ChatKit-event emission
- `CodexAppServerClient` for raw app-server request/notification flow across
  both `proxy` and `wasm` transport

If we want exact ChatKit request parity, an alternative is to call
`createCodexChatkitFetch()` directly with the same JSON bodies ChatKit would
send. But for most evals, the better seam is one layer lower:
`streamUserMessage(...)`.

Do not make the eval script talk to React components or DOM nodes directly.

## Proposed Architecture

```text
TS CLI
  -> Playwright Chromium
  -> page.evaluate(...)
  -> CodexConversationController or createCodexChatkitFetch()
  -> CodexAppServerClient
  -> transport = wasm
  -> AppKernel / notebook runtime / OPFS
```

The browser page is the runtime host.

The controller/fetch shim is the contract.

The DOM is incidental.

## Recommended Eval Layers

### 1. Preferred: Controller-Level Evals

Call the same controller methods the fetch shim uses:

- `ensureActiveThread()`
- `streamUserMessage(prompt, chatkitState, sink)`
- `refreshHistory()`
- `getThread(threadId)`
- `handleListItems(threadId)`

This gives us:

- the same app-server methods as the UI
- the same app-server notification subscription path as the UI
- the same ChatKit stream event derivation as the UI
- no dependency on the ChatKit React widget or DOM

This is the best seam for prompt evals because it reuses the real runtime logic
without forcing the test to construct full ChatKit HTTP payloads.

### 2. Optional: Fetch-Shim Evals

If we want exact parity with the ChatKit request contract, call
`createCodexChatkitFetch()` and send it the same request JSON that ChatKit
would send.

This is useful when we specifically want to validate:

- ChatKit request parsing
- ChatKit state injection
- SSE response formatting

But it is a slightly higher-level seam than most prompt evals need.

### 3. Raw Proxy Observation

For assertions on lower-level behavior, also use:

- `CodexAppServerClient.sendRequest(...)`
- `CodexAppServerClient.subscribeNotifications(...)`

This is the right place to observe:

- `thread/start`
- `turn/start`
- `turn/interrupt`
- streamed notifications

For `codex-wasm`, the browser-local worker/journal path is already present on
`main`, so evals can also query the wasm event journal through
`CodexWasmAppServerClient.getEventJournal()` when transport-specific inspection
is useful.

## Assertion Model

Each eval should produce a structured result object. Assertions should run in
Node against that object.

### Assertion Types

#### Tool / behavior assertions

Examples:

- observed a code-executor bridge request
- observed notebook mutation activity
- observed search-related `net.get(...)` access
- observed OPFS writes under `/code/runmedev/web`
- observed the Runme repo cache materialized in OPFS under `/code/runmedev/web`

These should come from journal entries, bridge payloads, and captured tool
outputs.

#### Result assertions

Examples:

- assistant text contains `runner`
- notebook contains a new code cell
- inserted cell source contains `hello world`

These should come from notebook snapshots and assistant output, not the DOM.

### Example Eval Shape

```ts
await runEval({
  name: "adds hello world cell",
  prompt: 'Add a cell to print "hello world".',
  assert(result) {
    expect(result.appServerRequests).toContainEntryMatching((entry) =>
      entry.method === "turn/start"
    );
    expect(result.notebook).toContainCellMatching((cell) =>
      typeof cell.value === "string" && cell.value.includes("hello world")
    );
  },
});
```

## Minimal Refactor Needed

### Recommendation

Yes, we should do a small refactor.

The refactor is not about moving logic into the DOM. It is about making the
existing runtime-facing pieces callable without React.

### What To Extract

Do not create a parallel prompt runtime.

Instead, extract only the minimum needed to let a browser-driven script call
the existing runtime services cleanly outside React.

The required refactor is:

1. Extract the Codex harness bootstrap logic currently embedded in
   `ChatKitPanel` into a reusable helper.
   This helper should own:
   - `controller.setSelectedProject(...)`
   - `proxy.setCodeExecutor(...)` for `codex-wasm`
   - `proxy.useTransport(...)`
   - `proxy.connectProxy(...)` or `proxy.connectWasm(...)`
   - `controller.refreshHistory()`
   - `controller.ensureActiveThread()`
   - cleanup via `proxy.disconnect()`,
     `proxy.setAuthorizationResolver(null)`, and
     `proxy.setCodeExecutor(null)`

2. Add a small helper around
   `CodexConversationController.streamUserMessage(...)` that collects emitted
   ChatKit events into an array and returns them with the next ChatKit state.
   This is a convenience wrapper, not a new runtime.

3. Add a thin browser-driver entrypoint so a Playwright/CDP script can call the
   existing singletons without mounting or controlling the ChatKit UI.
   That entrypoint should forward to the existing services and expose only:
   - bootstrap/configure runtime
   - run prompt
   - inspect notebook state
   - inspect wasm journal / app-server traces

4. Optionally extract a helper for building the wasm code executor from current
   app state.
   Today `ChatKitPanel` creates `codeModeExecutor` from notebook/UI state and
   then wraps it with `createCodexWasmCodeExecutor(...)`.
   If the eval driver reuses the same page/app state, this can stay mostly as
   is.
   If not, we should expose a helper that builds the same executor without
   depending on the full ChatKit component tree.

If we need a browser-global helper at all, it should be a tiny adapter over the
existing controller/proxy methods, not a new runtime layer.

### Why This Refactor Is Worth It

- cleaner separation between runtime and presentation
- stable test contract
- easier replay/debugging
- reusable for scripted demos and future benchmarking

## Implementation Plan

### Phase 0: Build The Eval Contract

Extract or expose only enough bootstrap code to let a browser-driven script:

- connect the unified app-server client in `wasm` mode
- call `streamUserMessage(...)` or the thin wrapper around it
- collect emitted ChatKit events
- inspect notebook state
- inspect request/notification traces
- inspect the wasm event journal

### Phase 1: Add A Node/TS Driver

Add a script, for example:

- `app/test/evals/runCodexEval.ts`

Responsibilities:

- launch headless Chromium
- open the app
- connect the same runtime libraries the UI uses
- seed notebook state if needed
- submit prompt
- fetch result object
- run assertions
- print structured pass/fail output

### Phase 2: Add A Tiny Initial Suite

Start with these evals:

1. `How do I add a jupyter kernel in Runme.`
   This is the first agentic-search eval.
   Success criteria:
   - turn completes
   - the agent performs search-like behavior over Runme source/docs
   - the Runme repo is fetched into OPFS under `/code/runmedev/web`
   - assistant output mentions the relevant Runme/Jupyter kernel setup path

2. `What is a runme runner?`
   Success criteria:
   - turn completes
   - assistant answer mentions runner semantics
   - traces show search-like behavior once agentic search lands

3. `Add a cell to print hello world.`
   Success criteria:
   - turn completes
   - notebook has a new cell
   - cell source contains `hello world`

## Current Dependency Boundary

The wasm runtime pieces are now present on `main`, including:

- `CodexAppServerClient`
- `CodexWasmAppServerClient`
- `CodexWasmWorkerClient`
- the wasm event journal

So the remaining dependency is not missing runtime code. The remaining work is
extracting the bootstrap and driver-facing entrypoint out of `ChatKitPanel`.

## Decision

For minimal evals, we should:

- use headless Chromium
- call the same controller/proxy methods the UI already uses
- bypass ChatKit React, but optionally reuse `createCodexChatkitFetch()` when
  exact ChatKit parity matters
- assert on app-server traces, notebook state, and assistant output
- do only a small extraction for bootstrap/test access, not a new runtime API

That gives us a faithful environment for agentic search and notebook mutation
tests without building a brittle browser UI test suite.
