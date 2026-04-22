# 20260421 Minimal Evals For Codex-WASM Agentic Search

## Status

Current proposal.

The core runtime seam exists. The remaining work is:

- add a small browser-side eval entrypoint
- add a Node/TS driver that launches a real browser and calls that entrypoint

## Summary

We want a minimal eval harness for `codex-wasm` that can:

- submit a prompt such as `What is a runme runner?`
- run and observe the turn programmatically
- assert on intermediate behavior such as tool usage
- assert on end state such as notebook mutations or final text

The recommended design is:

1. run evals in headless Chromium
2. use the same browser runtime services the app already uses
3. drive the runtime through `HarnessRuntimeManager` and
   `HarnessChatKitAdapter`, not through DOM automation
4. prefer `HarnessChatKitAdapter.streamUserMessage(...)` as the prompt seam
5. assert primarily against:
   - notebook state snapshots
   - assistant output / emitted ChatKit events
   - app-server requests and notifications
   - wasm event journal rows
   - OPFS contents when agentic search materializes source trees locally

The DOM should be incidental. We need a real browser runtime, but not a
browser-clicking test contract.

## Context

The newer `codex-wasm` direction is defined in the design docs:

- `20260415_agentic_search.md`
- `20260417_codex_wasm_appserver.md`

Agentic search quality depends on:

- prompts
- docs
- search behavior
- local browser storage state
- helper/runtime libraries

We need evals to measure those pieces systematically.

## Background: How The UI Works Today

The app has three harnesses:

- `codex`: remote app-server over websocket plus Codex tool bridge
- `codex-wasm`: browser-local wasm app-server in a dedicated Web Worker
- `responses-direct`: direct browser-side Responses API integration

The UI now has a cleaner split:

- `ChatKitPanel` owns page-state wiring and `useChatKit(...)`
- `HarnessRuntimeManager` owns runtime instance caching
- concrete `HarnessRuntime` classes own start/stop lifecycle
- `HarnessChatKitAdapter` is the harness-facing request surface
- `createChatKitFetchFromAdapter(...)` is only a compatibility shim for
  ChatKit's `fetch` requirement

The current flow is:

```text
ChatKitPanel
  -> build page-scoped runtime inputs
     - codeModeExecutor
     - codexBridgeHandler (proxy only)
     - auth resolver (proxy only)
  -> HarnessRuntimeManager.getOrCreate(...)
  -> runtime.start()
  -> runtime.createChatKitAdapter()
  -> createChatKitFetchFromAdapter(...)
  -> useChatKit(...)
```

For eval design, the important point is that the runtime seam is now explicit
and reusable below the React/DOM layer.

## Background: Per-Harness Initialization

### `codex` via proxy

`CodexProxyHarnessRuntime.start()` currently does:

1. optionally select the current Codex project
2. `getCodexAppServerClient().useTransport("proxy")`
3. install the proxy authorization resolver
4. `connectProxy(...)`
5. configure the `CodexToolBridge`
6. `refreshHistory()`
7. `ensureActiveThread()`

Prompt execution then flows through:

- `HarnessChatKitAdapter.streamUserMessage(...)`
- `CodexConversationController.streamUserMessage(...)`
- `CodexAppServerClient.sendRequest(...)`
- proxy app-server websocket notifications

### `codex-wasm`

`CodexWasmHarnessRuntime.start()` currently does:

1. optionally select the current Codex project
2. wrap the page's `codeModeExecutor` with `createCodexWasmCodeExecutor(...)`
3. `getCodexAppServerClient().useTransport("wasm")`
4. `connectWasm({ apiKey, sessionOptions })`
5. clear any proxy bridge state
6. `refreshHistory()`
7. `ensureActiveThread()`

Prompt execution still flows through the same:

- `HarnessChatKitAdapter`
- `CodexConversationController`
- `CodexAppServerClient`

The only transport difference is that the selected app-server backend is now
the browser-local wasm worker.

### `responses-direct`

`responses-direct` is now thinner:

- it creates a `ResponsesDirectChatKitAdapter`
- it does not require a heavy runtime `start()`
- tool execution is handled inside the harness, not by ChatKit

This matters because the eval seam should follow the harness boundary, not old
ChatKit-specific tool callback flows.

## Goals

- exercise the real `codex-wasm` runtime in a browser-faithful environment
- submit prompts and collect results from JS/TS, not by clicking UI controls
- support behavior assertions such as "did the agent search/fetch source?"
- support outcome assertions such as "did the notebook gain a cell containing
  `hello world`?"
- keep the first version small enough to implement quickly

## Non-Goals

- do not make DOM rendering the primary contract
- do not require pixel/UI automation for pass/fail
- do not build a full general-purpose benchmark runner up front
- do not build a second parallel prompt runtime

## Runtime Environment

### Recommendation

Use headless Chromium launched from a Node/TS driver.

Playwright is the simplest default. Raw CDP would also work.

### Why Chromium

`codex-wasm` depends on browser features that are not trustworthy in pure
Node-based test environments:

- Web Workers
- WebAssembly in a browser worker
- IndexedDB
- OPFS
- browser `fetch`
- the existing browser AppKernel integration

`jsdom` or a pure Vitest node environment is not faithful enough.

### Why Headless Browser Instead Of DOM Automation

We need browser capabilities, not a UI-driven contract.

The distinction should be:

- `yes` to a real browser runtime
- `no` to clicking the ChatKit composer and scraping rendered bubbles

The eval driver should call runtime APIs with `page.evaluate(...)`, not drive
React components.

## How To Invoke Prompts And Measure Responses

### Recommendation

Prefer the new harness/runtime seam:

- `HarnessRuntimeManager`
- concrete `HarnessRuntime`
- `HarnessChatKitAdapter`

For `codex-wasm`, the recommended flow is:

1. create/start the same runtime the UI uses
2. get the runtime's `HarnessChatKitAdapter`
3. call `adapter.streamUserMessage(...)`
4. collect emitted ChatKit events into an array
5. inspect notebook state, app-server traces, wasm journal, and OPFS

This is better than driving the DOM, and it is more aligned with the current
code than calling legacy fetch shims directly.

### Preferred Eval Seam

The preferred browser-side eval seam is:

```text
HarnessRuntimeManager
  -> CodexWasmHarnessRuntime
  -> HarnessChatKitAdapter.streamUserMessage(...)
  -> CodexConversationController
  -> CodexAppServerClient (transport = wasm)
  -> CodexWasmAppServerClient
  -> worker/app-server
```

### Optional Higher-Level Seam

If we want exact ChatKit request parity, we can still use:

- `createChatKitFetchFromAdapter(...)`

and send it the same request JSON that ChatKit sends.

That is useful for verifying:

- ChatKit request parsing
- JSON/SSE response formatting
- abort behavior

But for most evals, `HarnessChatKitAdapter.streamUserMessage(...)` is the
better seam.

### Optional Lower-Level Codex-Specific Seams

For Codex-specific debugging, we can also call:

- `CodexConversationController.streamUserMessage(...)`
- `CodexAppServerClient.sendRequest(...)`
- `CodexAppServerClient.subscribeNotifications(...)`
- `getCodexWasmAppServerClient().getEventJournal()`

Those are useful when we want lower-level traces, but they are more
transport-specific than the harness adapter seam.

## Proposed Architecture

```text
TS CLI
  -> Playwright Chromium
  -> page.evaluate(...)
  -> tiny browser eval entrypoint
  -> HarnessRuntimeManager.getOrCreate(...)
  -> runtime.start()
  -> runtime.createChatKitAdapter()
  -> adapter.streamUserMessage(...)
  -> notebook/AppKernel/OPFS + app-server traces + wasm journal
```

The browser page is the runtime host.

The harness runtime + adapter is the main contract.

The DOM is incidental.

## Recommended Eval Layers

### 1. Preferred: Adapter-Level Evals

Call the same adapter methods the UI now routes into:

- `listThreads()`
- `getThread(threadId)`
- `listItems(threadId)`
- `streamUserMessage({ input, threadId?, model? }, sink)`

This gives us:

- the same runtime startup path as the UI
- the same harness-specific prompt path as the UI
- no dependency on React or DOM state as the control plane

This should be the default minimal eval seam.

### 2. Optional: Fetch-Shim Evals

Call `createChatKitFetchFromAdapter(...)` with the adapter returned by the
runtime.

This is only needed if we specifically want to validate:

- ChatKit payload parsing
- SSE response formatting
- fetch/abort behavior

### 3. Low-Level Observation

For assertions on behavior, also collect:

- app-server requests sent through `CodexAppServerClient`
- app-server notifications
- wasm journal rows via `getCodexWasmAppServerClient().getEventJournal()`
- OPFS state, either directly or via the app's OPFS helpers

## Assertion Model

Each eval should produce a structured result object. Assertions should run in
Node against that object.

## Timing Metrics

Minimal evals should record at least these timing metrics for every turn.

### Time To First Message (TTFM)

`TTFM` is the elapsed time from prompt submission until the first assistant
message content is emitted.

This is the first visible sign of progress to the human, so it is the main
"how long did the user wait before seeing a response?" metric.

For implementation purposes, this should usually be measured from:

- start: when the eval submits the prompt to the harness adapter
- end: the first assistant message delta or first assistant message item added

### Turn Time

`TurnTime` is the elapsed time from prompt submission until the turn fully
completes.

This is the total end-to-end latency for the turn, including any search,
tooling, notebook mutation, and final assistant response.

For implementation purposes, this should usually be measured from:

- start: when the eval submits the prompt to the harness adapter
- end: the terminal turn-complete event

### Why Both Metrics Matter

- `TTFM` measures perceived responsiveness
- `TurnTime` measures total completion latency

An eval can have a good `TTFM` but a poor `TurnTime` if it responds quickly
and then spends a long time finishing the turn. We want to track both.

### Tool / behavior assertions

Examples:

- observed `turn/start`
- observed wasm journal rows for the turn
- observed code execution / notebook mutation behavior
- observed search-related network or file activity
- observed OPFS writes under `/code/runmedev/web`
- observed the Runme repo cache materialized in OPFS under `/code/runmedev/web`

These should come from request logs, notifications, journal rows, and storage
inspection.

### Result assertions

Examples:

- assistant text contains `runner`
- notebook contains a new code cell
- inserted cell source contains `hello world`

These should come from notebook snapshots and assistant output, not from the
rendered DOM.

### Example Eval Shape

```ts
await runEval({
  name: "adds hello world cell",
  prompt: 'Add a cell to print "hello world".',
  async assert(result) {
    expect(result.appServerRequests).toContainEntryMatching(
      (entry) => entry.method === "turn/start",
    );
    expect(result.notebook.cells).toContainEqual(
      expect.objectContaining({
        value: expect.stringContaining("hello world"),
      }),
    );
  },
});
```

## Current Runtime Boundary

The current code already provides:

- `HarnessRuntimeManager`
- `CodexProxyHarnessRuntime`
- `CodexWasmHarnessRuntime`
- `HarnessChatKitAdapter`
- `createChatKitFetchFromAdapter(...)`
- harness-owned tool handling

For evals, this means:

- we do **not** need to invent a new bootstrap layer
- we do **not** need a new Codex runtime API
- we should build on the harness/runtime seam that now exists

## Remaining Additions For Minimal Evals

### 1. Add a tiny browser-side eval entrypoint

We still need a small browser-side helper, likely test-only, that exposes the
runtime seam to Playwright/CDP.

That helper should do only this:

- construct the same runtime inputs `ChatKitPanel` constructs
  - `codeModeExecutor`
  - `codexBridgeHandler` for proxy mode
  - auth resolver for proxy mode
- call `HarnessRuntimeManager.getOrCreate(...)`
- `start()` the runtime
- `streamUserMessage(...)`
- collect emitted events
- return notebook / trace / journal / OPFS snapshots

This can be a small `window.__runmeEval` bridge or a test-only imported module.

### 2. Extract the page-scoped `codeModeExecutor` builder into a reusable helper

This is the recommended approach.

The main logic that still lives in `ChatKitPanel` is the page-state wiring for:

- `resolveCodeModeNotebook(...)`
- `listNotebooks(...)`
- renderer/notebook update hooks

For notebook-mutation evals, we should extract that logic into a reusable
helper rather than reconstruct it separately inside an eval driver.

#### Why extraction is the right approach

The alternatives are:

1. rebuild notebook resolution logic separately in the eval helper
2. keep the logic embedded in `ChatKitPanel` and somehow reach into component
   state from tests
3. extract a reusable builder and have both the UI and eval path call it

The third option is the cleanest because:

- the UI and evals will use the same notebook resolution rules
- notebook mutations will go through the same renderer/model update path
- `codex-wasm` and `responses-direct` will see the same `ExecuteCode`
  environment in normal UI use and in evals
- future notebook-related fixes only need to be made in one place

This is not a new runtime layer. It is just moving page-scoped wiring into a
shared helper.

#### What should be extracted

The helper should own:

- resolving a notebook from:
  - explicit URI
  - explicit handle
  - current visible notebook fallback
- enumerating open notebooks plus the current notebook
- applying notebook mutations through the same `NotebookData` model objects
- forwarding cell updates to the current renderer set

That means the helper should encapsulate the current `ChatKitPanel` logic for:

- `resolveCodeModeNotebook(...)`
- `listNotebooks(...)`
- `renderer.onCellUpdate(...)` fanout before `data.updateCell(...)`

#### Recommended helper shape

Something like:

```ts
type BuildPageCodeModeExecutorOptions = {
  getNotebookData: (uri: string) => NotebookDataLike | null;
  getOpenNotebookUris: () => string[];
  getCurrentDocUri: () => string | null;
  getRenderers: () => Iterable<{ onCellUpdate(cell: Cell): void }>;
};

function buildPageCodeModeExecutor(
  options: BuildPageCodeModeExecutorOptions,
): CodeModeExecutor
```

Internally, that helper can still create:

- a notebook resolver
- a notebook lister
- the final `createCodeModeExecutor(...)`

The important point is that callers should not need to rebuild that wiring
themselves.

#### Why return the final executor instead of intermediate pieces

Returning the final `CodeModeExecutor` is the better default because:

- `ChatKitPanel` wants the executor
- `CodexWasmHarnessRuntime` wants the executor
- `ResponsesDirectChatKitAdapter` wants the executor
- the eval entrypoint also wants the executor

If we instead expose only `resolveCodeModeNotebook(...)`, every caller would
still need to remember how to assemble:

- `listNotebooks(...)`
- renderer update hooks
- `createCodeModeExecutor(...)`

That would spread the same wiring back across multiple sites.

#### What should remain outside the helper

The helper should not own:

- harness selection
- `HarnessRuntimeManager`
- Codex auth resolution
- bridge connection
- app-server transport selection

Those belong to the harness runtime layer.

The helper is only for building the notebook-aware code execution environment
used by:

- `codex-wasm`
- Codex bridge tool handling
- `responses-direct` internal `ExecuteCode`

#### How the eval path would use it

With this extraction, the browser-side eval entrypoint can:

1. build the page-scoped `CodeModeExecutor` using the same helper as the UI
2. pass that executor into `HarnessRuntimeManager.getOrCreate(...)`
3. start the selected runtime
4. send prompts through `HarnessChatKitAdapter.streamUserMessage(...)`

That keeps the eval path aligned with the real notebook/runtime wiring instead
of approximating it.

### 3. Add request/journal capture helpers

Minimal evals should capture:

- outbound app-server requests
- inbound notifications
- wasm event journal rows

This can be done in the browser helper rather than by changing production
runtime APIs much further.

### 4. Add a Node/TS driver

Add a script, for example:

- `app/test/evals/runCodexEval.ts`

Responsibilities:

- launch headless Chromium
- open the app
- call the browser eval helper
- seed notebook state if needed
- submit prompt
- run assertions
- print structured pass/fail output

## Initial Eval Suite

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

## Decision

For minimal evals, we should:

- use headless Chromium
- reuse `HarnessRuntimeManager` and `HarnessChatKitAdapter`
- bypass ChatKit React and the DOM
- optionally reuse `createChatKitFetchFromAdapter(...)` when exact ChatKit
  parity matters
- assert on notebook state, assistant output, app-server traces, wasm journal,
  and OPFS state

The right seam is already present in the runtime. The remaining work is to add
a thin browser-side test entrypoint and a TS driver on top of it.
