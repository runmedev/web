# 20260417 Codex WASM App-Server

## Status

Draft proposal.

## Summary

Replace the current browser-local `BrowserCodex.submit_turn(...)` integration
with a browser-embedded app-server runtime hosted in a dedicated Web Worker.

The new browser stack should:

- run one long-lived wasm app-server runtime per browser session
- expose app-server-shaped requests, notifications, and server requests to the
  web app
- keep the runtime off the main thread
- record the full app-server boundary as an event journal for debugging and
  replay

This document updates the earlier
[20260414_codex_wasm.md](/Users/jlewi/code/runmecodex/web/docs-dev/design/20260414_codex_wasm.md)
plan to match the new upstream design in
`/Users/jlewi/code/codex/20260416_wasm_appserver.md`.

## Problem

The current Runme wasm path is still built around a thin `BrowserCodex`
wrapper:

- [codexWasmSession.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexWasmSession.ts)
  creates `new BrowserCodex(apiKey)`
- it configures host hooks such as `set_code_executor(...)`
- it sends one prompt with `submit_turn(prompt, onEvent)`
- it forwards raw Codex events back into the browser fetch shim

That was sufficient to prove that Codex core can run in the browser, but it is
the wrong long-term seam for Runme:

1. It bypasses the app-server protocol that native clients already use.
2. It keeps browser orchestration tied to a browser-specific wrapper instead of
   the maintained app-server control plane.
3. It makes multi-turn lifecycle, approvals, interruption, and future features
   harder to align with native Codex behavior.
4. It gives us no first-class place to capture a complete trace of the control
   plane.

The design change upstream is that the browser should stop treating `BrowserCodex`
as the stable boundary and instead embed the app-server runtime directly in wasm.

## Goals

- Replace the current `BrowserCodex` runtime path with an embedded app-server
  path.
- Keep one long-lived browser session instead of a turn-scoped runtime.
- Reuse app-server methods such as `thread/start`, `thread/read`,
  `turn/start`, `turn/interrupt`, and `turn/steer`.
- Keep the heavy runtime work off the main thread.
- Capture every app-server event emitted by Codex in a single browser-visible
  journal.
- Preserve the existing Runme browser host seams for code execution and other
  browser-owned tools.

## Non-Goals

- This document does not solve durable persistence across browser reloads.
- This document does not attempt full native parity for storage, recorder, or
  filesystem-backed features.
- This document does not require the ChatKit UI to understand raw app-server
  events directly.

## Current State In Runme

The current browser integration is split across:

- [codexWasmHarnessLoader.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexWasmHarnessLoader.ts)
  for loading the generated wasm bundle and `BrowserCodex`
- [codexWasmSession.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexWasmSession.ts)
  for session construction and `submitTurn(...)`
- [codexWasmChatkitFetch.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexWasmChatkitFetch.ts)
  for translating browser-local Codex events into ChatKit-style SSE

That code assumes a very small browser API:

- `new BrowserCodex(apiKey)`
- `setSessionOptions(...)`
- `set_code_executor(...)`
- `submit_turn(prompt, onEvent)`

The design in this document replaces that assumption with a browser-facing
app-server client and a worker-hosted runtime.

## Proposal

### High-Level Architecture

```text
ChatKit UI / Runme browser runtime
  -> CodexWasmConversationController
  -> CodexWasmWorkerClient
  -> Dedicated Web Worker
  -> wasm app-server wrapper
  -> codex_app_server::in_process
  -> MessageProcessor / Codex core
```

The main thread owns UI, ChatKit integration, and browser-only services.

The worker owns:

- loading the wasm module
- starting the long-lived in-process app-server runtime
- draining app-server events
- sequencing requests and responses
- appending every boundary message to the event journal

### Worker Decision

We should run the embedded app-server in a dedicated Web Worker.

This is a different decision from the older
[codexapp.md](/Users/jlewi/code/runmecodex/web/docs-dev/design/codexapp.md)
main-thread recommendation because the architecture has changed. We are no
longer only translating websocket messages in the browser. We are now hosting a
long-lived wasm runtime, JSON serialization, event fan-out, and server-request
handling inside the browser process.

Reasons to use a worker now:

1. The runtime is no longer just transport plumbing. It can parse large
   payloads, drive turn streams, and run background bookkeeping for the entire
   session.
2. Event bursts and wasm work should not compete with React rendering, input,
   or notebook UX on the main thread.
3. The worker gives us a single choke point for event journaling before the UI
   filters or transforms anything.
4. The worker boundary maps well to the app-server lifetime: start once, stream
   for many turns, shut down explicitly.

Costs:

- we add a `postMessage` protocol between main thread and worker
- browser-only services such as the sandbox kernel must be proxied back to the
  main thread

Those costs are acceptable because they produce a cleaner split than letting the
wasm runtime share the UI thread.

Decision:

- use a dedicated Web Worker for v1 of the embedded wasm app-server design
- keep the worker protocol narrow and app-server-shaped
- do not expose the worker directly to ChatKit; keep a main-thread controller
  boundary

### Main-Thread Responsibilities

The main thread should own:

- `CodexWasmConversationController`
  - maps ChatKit requests onto app-server operations
  - tracks selected thread and current turn state
  - translates app-server events into ChatKit SSE
- `CodexWasmWorkerClient`
  - request/response correlation for worker messages
  - subscription to streamed worker events
  - worker lifecycle and restart handling
- browser-owned services
  - sandbox code executor
  - notebook bridge access
  - local UI state and thread list presentation

### Worker Responsibilities

The worker should own:

- module initialization for the generated wasm app-server bundle
- creation of one long-lived app-server client handle
- a request API:
  - `request`
  - `notify`
  - `respondToServerRequest`
  - `failServerRequest`
  - `shutdown`
- background draining of app-server events
- the event journal
- replay/dump APIs for debugging

The worker should not own ChatKit-specific concepts.

### Browser-Facing API

The main-thread worker client should expose a thin typed interface close to the
app-server protocol:

- `start(options)`
- `request(method, params)`
- `notify(method, params)`
- `subscribe(listener)`
- `respondToServerRequest(requestId, result)`
- `failServerRequest(requestId, error)`
- `getEventJournal(filter?)`
- `resetEventJournal()`
- `shutdown()`

Internally the worker can still use `next_event()` or an equivalent callback
drain. The browser-facing API should be push-based.

Decision:

- use callback subscription as the primary event delivery model
- keep polling or dump-style helpers only for tests and debugging

### Event Model

The browser should consume app-server events, not raw direct-thread
`submit_turn(...)` callbacks.

The event stream must include:

- server notifications
- server requests
- worker lifecycle markers
- code executor bridge requests and responses
- backpressure or queue overflow diagnostics

The browser controller can derive higher-level ChatKit events from that stream,
but the raw app-server-shaped stream should remain available for debugging.

### Shared ChatKit Translation Layer

Moving both browser-embedded Codex and remote app-server Codex onto the same
app-server event vocabulary means we should share the
`app-server events -> ChatKit SSE` translation code.

The reusable split should be:

- source adapters
  - embedded wasm app-server worker events
  - remote websocket app-server events
- shared translator
  - normalized app-server envelopes to ChatKit-visible stream events
- sink adapters
  - `ReadableStream` / SSE emission and controller-specific wiring

This does not mean both paths will share the same full controller. They still
have different responsibilities around transport, auth, reconnect, runtime
lifecycle, and browser tool bridging. The thing we should share is the pure
translation layer that maps app-server-shaped lifecycle events onto the ChatKit
event model.

## Recording All App-Server Events

### Decision

Record the app-server boundary inside the worker with a structured append-only
journal. Every message that crosses the worker/app-server boundary or the
worker/main-thread boundary should be assigned a sequence number and appended
before any filtering or transformation.

This is the authoritative answer to "how do we record all app-server events that
Codex emits": the worker is the single recorder, and the journal stores raw
protocol-shaped envelopes plus metadata.

### Journal Schema

Each journal entry should include:

- `seq`
- `ts`
- `sessionId`
- `threadId` when known
- `turnId` when known
- `direction`
  - `client_to_server`
  - `server_to_client`
  - `worker_to_main`
  - `main_to_worker`
- `kind`
  - `request`
  - `request_result`
  - `notification`
  - `server_request`
  - `server_request_response`
  - `bridge_request`
  - `bridge_response`
  - `lifecycle`
- `method`
- `requestId` when present
- `payload`
- `summary`
  - short derived fields used for logs and devtools

We should keep the raw payload, not only a reduced summary, because the main use
case is debugging protocol mismatches and missing events.

### Recording Points

The worker should append journal entries at these points:

1. before sending a client request into the embedded app-server
2. after receiving the request result
3. whenever the app-server emits a server notification
4. whenever the app-server emits a server request
5. whenever the main thread responds to or rejects a server request
6. whenever the worker asks the main thread to execute browser-owned work such
   as code execution
7. whenever that browser-owned work resolves or fails
8. on worker startup, shutdown, reset, crash, and restart

### Storage Strategy

Use a single append-only journal in IndexedDB as the source of truth.

Each journal entry should be written directly to IndexedDB from the worker as it
is recorded. Reads for debug panels, exports, or thread/turn filtering should
query IndexedDB rather than consulting a separate in-memory buffer.

The worker should talk to IndexedDB directly. Dedicated Web Workers can use
IndexedDB APIs, so we do not need to proxy journal writes through the main
thread.

Reasons to prefer one persistent store:

1. It removes duplication between a volatile ring buffer and a persisted trace.
2. It makes inspection after crashes or reloads straightforward because the same
   data source survives worker restarts.
3. It reduces ambiguity about which store is authoritative when exporting or
   debugging a session.

Costs and mitigations:

- IndexedDB writes are asynchronous.
  Mitigation: journal appends should be fire-and-forget and should never block
  turn processing on completion of the write.
- Unbounded growth is risky.
  Mitigation: apply retention rules such as max age, max sessions, or max bytes
  per session, and expose explicit deletion/reset APIs.
- Raw payloads may contain normal conversation or tool data.
  Mitigation: manage this through retention and developer-facing access policy,
  not through a separate redaction layer.

The worker may still keep a tiny ephemeral write queue or batch for efficiency,
but that queue is an implementation detail, not a second journal store.

### Journal Content Policy

The journal should store raw app-server events and requests as they are emitted,
wrapped in the journal row metadata.

We should not add a separate redaction pass. The simplification is:

- journal the raw app-server protocol boundary
- do not journal bootstrap/config objects that are not protocol events
- treat the journal as a faithful append log of requests, responses,
  notifications, and server requests

Under that rule, credentials such as the API key should not appear in the
journal because they are not part of the app-server event stream we are
recording.

### Browser APIs For Inspection

The worker client should expose:

- `getEventJournal({ threadId?, turnId?, sinceSeq? })`
- `exportEventJournal({ format: "json" | "ndjson" })`
- `resetEventJournal()`

Runme can later expose these through App Console helpers or a debug panel.

## Browser-Owned Tool Execution

Running the app-server in a worker does not remove the need for main-thread
browser services.

For code mode and similar browser-owned tools:

1. the app-server emits a server request or invokes the configured bridge in the
   worker
2. the worker appends a journal entry
3. the worker sends a `bridge_request` to the main thread
4. the main thread executes against the sandbox kernel or notebook bridge
5. the main thread returns `bridge_response`
6. the worker appends another journal entry and resolves the app-server request

This keeps the runtime isolated without pretending that browser-only services
can run inside the worker.

### Worker And Sandbox Iframe Communication

In the current Runme architecture, the worker should not talk to the sandbox
iframe by owning the iframe directly.

Today
[sandboxJsKernel.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/sandboxJsKernel.ts)
creates the iframe with `document.createElement('iframe')`, appends it to
`document.body`, and establishes the `MessageChannel` handshake from the main
thread. That means the current sandbox runtime is explicitly DOM-owned and
main-thread-owned.

A Web Worker cannot access `document`, `iframe.contentWindow`, or other DOM
objects directly. So the worker cannot implement the current `SandboxJSKernel`
path by itself.

There are two viable models:

1. Main-thread broker
   - worker sends `bridge_request`
   - main thread owns the sandbox iframe lifecycle and request routing
   - main thread returns `bridge_response`
2. Transferred-port model
   - main thread still creates the iframe and initial handshake
   - main thread transfers a `MessagePort` to the worker
   - worker and iframe exchange RPCs over that port after setup

The second model is technically possible, but it still requires the main thread
to own iframe creation and teardown. For v1 we should keep the simpler
main-thread broker model because it matches the existing sandbox implementation,
keeps DOM concerns out of the worker, and leaves room to transfer ports later if
we need to reduce one hop in the bridge.

### Alternative: Dual-Channel Sandbox Communication

Another viable design is to give the iframe multiple communication channels so
both the main thread and the worker can talk to it directly.

Important constraint:

- one `MessageChannel` produces exactly two entangled `MessagePort`s
- a single `MessagePort` is not a multi-owner bus
- if both the main thread and the worker need direct communication with the
  iframe, we should use multiple channels rather than trying to share one port

That design would look like:

1. Main thread creates sandbox iframe.
2. Main thread creates `MessageChannel A`.
   - main thread keeps `portA1`
   - iframe receives `portA2`
3. Main thread creates `MessageChannel B`.
   - worker receives `portB1`
   - iframe receives `portB2`

After bootstrap, the topology is:

- main thread `<->` iframe on channel A
- worker `<->` iframe on channel B

This removes the need to proxy every worker-originated sandbox request through
the main thread after setup. The main thread is still required for iframe
creation, initial handshake, and teardown because those are DOM-bound.

### Why V1 Uses A Single Main-Thread-Owned Sandbox Channel

For v1 we should still prefer the simpler main-thread-broker model over the
dual-channel design.

Reasons:

1. It matches the current `SandboxJSKernel` ownership model, where one host-side
   controller owns iframe setup, request handling, and disposal.
2. It avoids two independent controllers issuing commands into the same sandbox
   runtime without an additional arbitration layer.
3. It keeps ordering, cancellation, and shutdown semantics simpler because the
   main thread remains the single gateway into the iframe.
4. It reduces debugging ambiguity. If a sandbox request fails, there is one host
   path to inspect rather than separate worker and main-thread command streams.
5. It is sufficient for the expected v1 workload, where sandbox tool calls are
   important but not yet proven to be hot enough to justify a more complex
   topology.

The dual-channel design remains a good future optimization if per-request
main-thread proxying becomes a measurable bottleneck. If we take that path
later, we should add explicit ownership rules for:

- which operations are allowed from the worker vs the main thread
- request id and response correlation across both channels
- cancellation and teardown ordering
- whether the iframe exposes one logical RPC router or separate per-port
  capabilities

## Changes In Runme Web

### Replace Current Runtime Files

The current runtime should move from a `BrowserCodex` wrapper to an app-server
worker client.

Expected refactor:

- replace the current `BrowserCodexInstance` assumption in
  [codexWasmHarnessLoader.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexWasmHarnessLoader.ts)
  with a generated wasm app-server wrapper entrypoint
- replace `createCodexWasmSession(...)` in
  [codexWasmSession.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexWasmSession.ts)
  with `createCodexWasmWorkerClient(...)`
- update
  [codexWasmChatkitFetch.ts](/Users/jlewi/code/runmecodex/web/app/src/lib/runtime/codexWasmChatkitFetch.ts)
  to call `thread/start`, `thread/read`, `turn/start`, and `turn/interrupt`
  through the controller rather than `submitTurn(...)`
- add a worker-hosted event journal module

### Suggested New Modules

- `codexWasmWorker.ts`
  - dedicated worker entrypoint
- `codexWasmWorkerProtocol.ts`
  - shared message types for main thread and worker
- `codexWasmWorkerClient.ts`
  - main-thread facade
- `codexWasmAppServerClient.ts`
  - typed app-server helpers over the worker protocol
- `codexWasmEventJournal.ts`
  - journal schema, IndexedDB append/query helpers, export helpers
- `codexWasmConversationController.ts`
  - ChatKit-facing lifecycle logic

## Migration Plan

### Phase 1: Worker-Hosted Runtime

- load the wasm app-server bundle inside a dedicated worker
- start one long-lived embedded runtime
- expose request/notification/server-request operations to the main thread
- prove multi-turn continuity without per-turn session reset

Success criteria:

- the browser no longer uses `submit_turn(...)`
- the runtime survives multiple turns in the same thread
- the worker can service code executor callbacks through the main thread

### Phase 2: Event Journal

- add the structured journal in the worker
- expose inspection and export APIs
- log every request, response, notification, and server request

Success criteria:

- a failed or stalled turn can be debugged from the recorded journal alone
- the browser can inspect the raw event sequence without reproducing the issue

### Phase 3: ChatKit Controller Migration

- move `codexWasmChatkitFetch.ts` off the current prompt-based shim
- create or refactor a controller that uses app-server thread/turn operations
- keep ChatKit-facing SSE output stable

Success criteria:

- ChatKit still receives the same user-visible stream shape
- the underlying control plane is now app-server-native

## Risks

- The worker bridge adds another protocol layer and needs disciplined type
  definitions.
- Browser-owned tools may introduce latency because they cross worker/main-thread
  boundaries.
- App-server persistence remains unresolved across reloads.
- Journal payload growth could become expensive if we persist everything by
  default.

## Recommended Decisions

- Runtime placement
  Recommendation: run the embedded wasm app-server in a dedicated Web Worker.

- Event delivery
  Recommendation: use push subscriptions as the primary browser event model,
  with dump/poll helpers only for tests and debug tooling.

- Event recording
  Recommendation: record the raw app-server boundary in a worker-owned
  append-only IndexedDB journal as the single source of truth.

- Tool execution
  Recommendation: proxy browser-owned tools from worker to main thread and log
  both halves of the bridge as journal events.

- Runme integration
  Recommendation: replace the current `BrowserCodex`-based session wrapper
  rather than maintaining both runtime paths.

## Recommendation

Runme should replace the current `BrowserCodex` integration with a dedicated
worker-hosted embedded app-server runtime and a first-class event journal.

That gives us the right control plane, keeps the UI thread clear, and gives us
a complete trace of what Codex emitted during each browser session.
